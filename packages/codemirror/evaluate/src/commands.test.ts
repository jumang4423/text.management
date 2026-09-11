import { Text } from "@codemirror/state";

import { dChannelsInBlock, paragraphRange } from "./commands";

describe("dChannelsInBlock", () => {
  test("finds a single channel", () => {
    expect(dChannelsInBlock('d1 $ s "bd"')).toEqual(new Set(["1"]));
  });

  test("finds multi-digit channels", () => {
    expect(dChannelsInBlock("d12 $ s \"bd\"")).toEqual(new Set(["12"]));
  });

  test("finds several channels in one block", () => {
    expect(
      dChannelsInBlock('d1 $ s "bd"\nd2 $ s "hh"')
    ).toEqual(new Set(["1", "2"]));
  });

  test("ignores channels inside strings", () => {
    expect(dChannelsInBlock('d1 $ s "d2 $ bd"')).toEqual(new Set(["1"]));
  });

  test("ignores channels inside line comments", () => {
    expect(dChannelsInBlock("-- d9 $ s \"bd\"\nd3 $ s \"hh\"")).toEqual(
      new Set(["3"])
    );
  });

  test("ignores channels inside block comments", () => {
    expect(dChannelsInBlock("{- d9 $ s \"bd\" -}\nd3 $ s \"hh\"")).toEqual(
      new Set(["3"])
    );
  });

  test("returns an empty set when there is no channel", () => {
    expect(dChannelsInBlock('s "bd"')).toEqual(new Set());
  });
});

describe("paragraphRange", () => {
  const doc = Text.of(['d1 $ s "bd"', "  # room 0.8", "", 'd2 $ s "hh"']);

  test("expands to the surrounding paragraph", () => {
    expect(paragraphRange(doc, 5)).toEqual({ from: 0, to: doc.line(2).to });
  });

  test("stops at blank lines", () => {
    const last = doc.line(4);
    expect(paragraphRange(doc, last.from)).toEqual({
      from: last.from,
      to: last.to,
    });
  });

  test("clamps out-of-range positions", () => {
    expect(paragraphRange(doc, -99)).toEqual({ from: 0, to: doc.line(2).to });
    expect(paragraphRange(doc, 9999)).toEqual({
      from: doc.line(4).from,
      to: doc.line(4).to,
    });
  });
});
