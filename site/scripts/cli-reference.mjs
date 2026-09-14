// Writes _data/cli.json: the command tree of the built CLI, read from commander
// itself (../dist/src/cli/program.js), so the website's command reference can't
// drift from the code. Build the CLI first: `npm run build` in the repository root.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const programFile = join(root, 'dist', 'src', 'cli', 'program.js');
if (!existsSync(programFile)) {
  console.error(`${programFile} not found: run "npm run build" in the repository root first.`);
  process.exit(1);
}

const { buildProgram } = await import(pathToFileURL(programFile).href);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const formatDefault = (option) => {
  if (option.defaultValueDescription) return option.defaultValueDescription;
  if (option.defaultValue === undefined || option.negate) return null;
  return typeof option.defaultValue === 'string' ? option.defaultValue : JSON.stringify(option.defaultValue);
};

const option = (o) => ({
  flags: o.flags,
  description: o.description ?? '',
  default: formatDefault(o),
  choices: o.argChoices ?? null,
  required: Boolean(o.mandatory),
});

const argument = (a) => ({
  name: a.name(),
  required: a.required,
  variadic: a.variadic,
  description: a.description ?? '',
});

const visible = (commands) => commands.filter((c) => !c._hidden);

const command = (c, parents) => {
  const path = [...parents, c.name()];
  return {
    name: c.name(),
    // Anchor id and display path without the program name.
    id: path.slice(1).join('-'),
    path: path.join(' '),
    usage: `${path.join(' ')} ${c.usage()}`.trim(),
    description: c.description() ?? '',
    aliases: c.aliases(),
    arguments: c.registeredArguments.map(argument),
    options: c.options.filter((o) => !o.hidden).map(option),
    commands: visible(c.commands).map((sub) => command(sub, path)),
  };
};

const program = buildProgram();
const data = {
  bin: program.name(),
  version: pkg.version,
  description: program.description() ?? '',
  options: program.options.filter((o) => !o.hidden).map(option),
  commands: visible(program.commands).map((c) => command(c, [program.name()])),
};

const count = (list) => list.reduce((n, c) => n + 1 + count(c.commands), 0);
mkdirSync(join(here, '..', '_data'), { recursive: true });
writeFileSync(join(here, '..', '_data', 'cli.json'), JSON.stringify(data, null, 2) + '\n');
console.log(`Wrote _data/cli.json: ${data.bin} ${data.version}, ${count(data.commands)} commands`);
