import * as core from './core.js';
import { commands } from './commands.js';

export async function run(env = process.env) {
  const name = core.input('command', env).toLowerCase();
  const command = commands[name];
  if (!command) {
    core.fail(`command must be one of: ${Object.keys(commands).join(', ')}`);
    return;
  }
  try {
    await command({ env });
  } catch (err) {
    core.fail(err.message);
  }
}
