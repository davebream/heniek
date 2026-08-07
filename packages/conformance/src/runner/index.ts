// Deliberately does not re-export `./vitest.js` — that module imports
// vitest and is only reachable through the package's `./vitest` subpath
// export, so importing the main package barrel never pulls in a test
// framework.
export { runConformanceCase } from "./case-context.js";
