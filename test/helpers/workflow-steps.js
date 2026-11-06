import { readFileSync } from 'node:fs';

// Extract the `run: |` script of a named workflow step, dedented.
export function step(workflow, name) {
  const section = workflow.split(`      - name: ${name}\n`)[1];
  if (!section) throw new Error(`missing step: ${name}`);
  return section.split('        run: |\n')[1]
    .split('\n').reduce((lines, line) => {
      if (lines.done) return lines;
      if (line.startsWith('          ')) lines.push(line.slice(10));
      else lines.done = true;
      return lines;
    }, []).join('\n');
}

// Parse a GITHUB_OUTPUT file into an object.
export function outputs(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));
}
