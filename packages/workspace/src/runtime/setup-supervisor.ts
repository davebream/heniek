import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

interface StartMessage {
  readonly type: "start";
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly logPath: string;
}

const REDACT = /(password|secret|token|api[-_]?key|credential)(\s*[=:]\s*)\S+/gi;
const MAX_LOG_BYTES = 1_048_576;
const TRUNCATION_MARKER = "\n[heniek] output truncated at 1048576 bytes\n";
const MAX_CONTENT_BYTES = MAX_LOG_BYTES - Buffer.byteLength(TRUNCATION_MARKER);
let started = false;

process.send?.({ type: "ready", processGroupId: process.pid });

process.on("disconnect", () => {
  if (!started) process.exit(1);
});

process.on("message", (message: StartMessage) => {
  if (started || message.type !== "start") return;
  started = true;
  const fd = openSync(message.logPath, "a", 0o600);
  const child = spawn("/bin/sh", ["-c", message.command], {
    cwd: message.cwd,
    env: message.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pending = { stdout: "", stderr: "", runner: "" };
  let writtenBytes = 0;
  let truncated = false;
  const writeRedacted = (label: keyof typeof pending, value: string) => {
    const redacted = value.replace(REDACT, "$1$2[REDACTED]");
    const bytes = Buffer.from(`[${label}] ${redacted}`);
    const room = MAX_CONTENT_BYTES - writtenBytes;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const retained = bytes.subarray(0, room);
    writeSync(fd, retained);
    writtenBytes += retained.byteLength;
    if (retained.byteLength < bytes.byteLength) truncated = true;
  };
  const write = (label: keyof typeof pending, chunk: Buffer) => {
    pending[label] += chunk.toString("utf8");
    const newline = pending[label].lastIndexOf("\n");
    if (newline >= 0) {
      writeRedacted(label, pending[label].slice(0, newline + 1));
      pending[label] = pending[label].slice(newline + 1);
    }
    if (pending[label].length > 4096) {
      writeRedacted(label, pending[label].slice(0, -256));
      pending[label] = pending[label].slice(-256);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => write("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => write("stderr", chunk));
  child.on("error", (error) => write("runner", Buffer.from(`${error.message}\n`)));
  child.on("close", (code, signal) => {
    for (const [label, value] of Object.entries(pending)) {
      if (value.length > 0) writeRedacted(label as keyof typeof pending, value);
    }
    if (truncated) {
      writeSync(fd, TRUNCATION_MARKER);
    }
    closeSync(fd);
    process.send?.({ type: "completed", exitCode: code ?? 1, signal: signal ?? null });
    process.disconnect();
  });
});
