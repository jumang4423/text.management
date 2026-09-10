const multilineBlock =
  /^[ \t]*:{[ \t]*\r?\n((?:[ \t]*(?:[^:\s].*|:|:[^}].*|:}.*\S.*)?\r?\n)*)[ \t]*:}[ \t]*$/m;
const indentedStatement = /([ \t]*)\S.*(?:\r?\n\1[ \t]+\S.*)*/g;

export function extractStatements(code: string) {
  // Partially parsed blocks of code
  let blocks: string[] = code.split(multilineBlock);
  let plainBlock: string, bracketBlock: string;

  // Final parsed statements
  let statements: string[] = [];

  while (blocks.length > 0) {
    [plainBlock, bracketBlock, ...blocks] = blocks;

    for (let [statement] of plainBlock.matchAll(indentedStatement)) {
      statements.push(statement);
    }

    if (bracketBlock) {
      statements.push(bracketBlock);
    }
  }

  return statements;
}

// Parses the marker line printed by tmActiveDs in BootTidal.hs
// (e.g. "TM-ACTIVE 1 3", or bare "TM-ACTIVE" when nothing sounds).
export function parseActiveOrbitsMarker(
  text: string | undefined
): number[] | null {
  for (const line of text?.split(/\r?\n/) ?? []) {
    const match = line.match(/^TM-ACTIVE((?: +\d+)*)\s*$/);
    if (!match) continue;
    const orbits = match[1]
      .trim()
      .split(/ +/)
      .filter((part) => part.length > 0)
      .map(Number);
    if (orbits.every((orbit) => Number.isInteger(orbit))) return orbits;
  }
  return null;
}
