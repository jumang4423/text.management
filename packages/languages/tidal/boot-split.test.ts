import { readFileSync } from "fs";
import { extractStatements } from "./parse";

describe("BootTidal.hs statement splitting", () => {
  test("tmActiveDs helper survives as whole statements", () => {
    const code = readFileSync("/Users/jumang4423/sc-dotfiles/BootTidal.hs", "utf-8");
    const statements = extractStatements(code);
    const joined = statements.join("\n");
    expect(joined).toContain("tmActiveDs = do");
    expect(joined).toContain('putStrLn ("TM-ACTIVE"');
    expect(joined).toContain("tmActiveN pmap n = case TMMap.lookup n pmap of");
  });

  test("tmActiveDs binding is a single statement", () => {
    const code = readFileSync("/Users/jumang4423/sc-dotfiles/BootTidal.hs", "utf-8");
    const statements = extractStatements(code);
    const defining = statements.filter((statement) =>
      statement.includes("tmActiveDs = do")
    );
    expect(defining).toHaveLength(1);
    expect(defining[0]).toContain("tmActiveN pmap n = case");
  });
});
