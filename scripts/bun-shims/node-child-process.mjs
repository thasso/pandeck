import * as childProcess from "node:child_process";

/**
 * Node's child_process with Node's `env` default restored for the synchronous
 * calls. Bun 1.3.13's spawnSync, execFileSync and execSync start a child that
 * was given no `env` with the environment the process STARTED with, not the
 * current `process.env`: a variable the server deleted at boot (the instance
 * token, integration secrets) still reaches the child, and one it set does not.
 * The asynchronous calls already follow `process.env`. This covers every
 * bundled caller, the server's own and its dependencies' alike.
 */
function withCurrentEnv(options) {
  // Node reads `env: null` as omitted too; Bun would then start the child with
  // the start-up environment. An env object, even `{}`, is the caller's.
  if (isOptions(options) && options.env != null) return options;
  return { ...options, env: process.env };
}

function isOptions(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `(file[, args][, options])`, the shape of both spawnSync and execFileSync. */
function withArgs(call) {
  return (file, args, options) =>
    Array.isArray(args) || (args == null && options !== undefined)
      ? call(file, args ?? [], withCurrentEnv(options))
      : call(file, withCurrentEnv(isOptions(args) ? args : undefined));
}

export const spawnSync = withArgs(childProcess.spawnSync);
export const execFileSync = withArgs(childProcess.execFileSync);
export function execSync(command, options) {
  return childProcess.execSync(command, withCurrentEnv(options));
}

export const { ChildProcess, exec, execFile, fork, spawn } = childProcess;

export default {
  ...childProcess,
  spawnSync,
  execFileSync,
  execSync,
};
