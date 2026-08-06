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
  const writeRedacted = (label: keyof typeof pending, value: string) => {
    const redacted = value.replace(REDACT, "$1$2[REDACTED]");
    writeSync(fd, `[${label}] ${redacted}`);
  };
  const write = (label: keyof typeof pending, chunk: Buffer) => {
    pending[label] += chunk.toString("utf8");
    const newline = pending[label].lastIndexOf("\n");
    if (newline < 0) return;
    writeRedacted(label, pending[label].slice(0, newline + 1));
    pending[label] = pending[label].slice(newline + 1);
  };
  child.stdout.on("data", (chunk: Buffer) => write("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => write("stderr", chunk));
  child.on("error", (error) => write("runner", Buffer.from(`${error.message}\n`)));
  child.on("close", (code, signal) => {
    for (const [label, value] of Object.entries(pending)) {
      if (value.length > 0) writeRedacted(label as keyof typeof pending, value);
    }
    closeSync(fd);
    process.send?.({ type: "completed", exitCode: code ?? 1, signal: signal ?? null });
    process.disconnect();
  });
});
