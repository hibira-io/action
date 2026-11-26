// Minimal stand-ins for @actions/core, so the action has no dependencies
// and needs no build step.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EOL } from 'node:os';

let write = (s) => process.stdout.write(s);

// setWriter sends workflow commands and log lines elsewhere (tests).
export function setWriter(fn) {
  const prev = write;
  write = fn;
  return prev;
}

export function input(name, env = process.env) {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined ? '' : v.trim();
}

// list splits an input on new lines and commas.
export function list(name, env = process.env) {
  return input(name, env)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function bool(name, fallback, env = process.env) {
  const v = input(name, env).toLowerCase();
  if (v === '') return fallback;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

export function int(name, { min, max }, env = process.env) {
  const v = input(name, env);
  if (v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function fileCommand(variable, text, env) {
  const file = env[variable];
  if (!file) return false;
  appendFileSync(file, text, 'utf8');
  return true;
}

export function setOutput(name, value, env = process.env) {
  const v = value === undefined || value === null ? '' : String(value);
  const delim = `ghadelimiter_${randomUUID()}`;
  if (!fileCommand('GITHUB_OUTPUT', `${name}<<${delim}${EOL}${v}${EOL}${delim}${EOL}`, env)) {
    write(`::set-output name=${name}::${escapeData(v)}${EOL}`);
  }
}

export function summary(markdown, env = process.env) {
  fileCommand('GITHUB_STEP_SUMMARY', markdown + EOL, env);
}

function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function info(msg) {
  write(msg + EOL);
}

export function notice(msg, title) {
  const props = title ? ` title=${escapeProperty(title)}` : '';
  write(`::notice${props}::${escapeData(msg)}${EOL}`);
}

export function warning(msg) {
  write(`::warning::${escapeData(msg)}${EOL}`);
}

export function mask(value) {
  if (value) write(`::add-mask::${escapeData(value)}${EOL}`);
}

export function fail(msg) {
  write(`::error::${escapeData(msg)}${EOL}`);
  process.exitCode = 1;
}
