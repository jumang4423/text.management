import { dChannelsInBlock } from "./commands";

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
