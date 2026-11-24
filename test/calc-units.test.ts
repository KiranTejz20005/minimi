import { describe, it, expect } from "vitest";
import { convertUnits } from "../src/tools/calc/units.js";
import { CalcError } from "../src/tools/calc/errors.js";

const cases: [string, string][] = [
  ["5 miles to km", "8.04672"],
  ["8.04672 km to miles", "5"],
  ["1 mi in ft", "5280"],
  ["1 km to m", "1000"],
  ["100 cm to in", "39.3700787402"],
  ["6 feet to cm", "182.88"],
  ["12 inches to ft", "1"],
  ["1 nautical mile to m", "1852"],
  ["1 kg to lb", "2.20462262185"],
  ["10 lb to kg", "4.5359237"],
  ["16 oz to lb", "1"],
  ["1 tonne to kg", "1000"],
  ["500 g to oz", "17.6369809748"],
  ["1 gallon to liters", "3.785411784"],
  ["1 L to ml", "1000"],
  ["2 cups to ml", "473.176473"],
  ["1 tbsp to tsp", "3"],
  ["12 fl oz to ml", "354.88235475"],
  ["72 F to C", "22.2222222222"],
  ["22.2222222222222 C to F", "72"],
  ["0 C to F", "32"],
  ["100 C to K", "373.15"],
  ["0 K to C", "-273.15"],
  ["-40 F to C", "-40"],
  ["98.6 °F to °C", "37"],
  ["60 mph to km/h", "96.56064"],
  ["100 km/h to m/s", "27.7777777778"],
  ["10 knots to km/h", "18.52"],
  ["1 acre to m2", "4046.8564224"],
  ["1 hectare to acres", "2.47105381467"],
  ["100 sq ft to m2", "9.290304"],
  ["2 hours to minutes", "120"],
  ["1 day to hours", "24"],
  ["1 week to days", "7"],
  ["90 minutes to hours", "1.5"],
  ["1 year to days", "365.2425"],
  ["1 GB to MB", "1000"],
  ["1 GiB to MiB", "1024"],
  ["1 GiB to GB", "1.073741824"],
  ["1 byte to bits", "8"],
  ["8 Mb to MB", "1"],
  ["1 TB to GiB", "931.322574615"],
  ["1 kWh to MJ", "3.6"],
  ["1 kcal to kJ", "4.184"],
  ["1 BTU to J", "1055.05585262"],
  ["1 atm to psi", "14.6959487755"],
  ["1 bar to kPa", "100"],
  ["14.7 psi to kPa", "101.35293221"],
  ["760 torr to atm", "1"],
  ["760 mmHg to atm", "1.00000014247"],
];

describe("convertUnits", () => {
  it.each(cases)("%s => %s", (expr, expected) => {
    expect(convertUnits(expr).result).toBe(expected);
  });
  it("has at least 40 cases", () => expect(cases.length).toBeGreaterThanOrEqual(40));

  it("shows the conversion in the text", () => {
    expect(convertUnits("5 miles to km").text).toBe("5 miles = 8.04672 km");
  });
  it("accepts 'in' and '->' separators and sign/decimal/sci values", () => {
    expect(convertUnits("5 in in cm").result).toBe("12.7");
    expect(convertUnits("1.5e3 m -> km").result).toBe("1.5");
    expect(convertUnits("-10 C to F").result).toBe("14");
    expect(convertUnits("1,000 m to km").result).toBe("1");
  });
});

describe("convertUnits errors", () => {
  const bad: [string, RegExp][] = [
    ["5 miles to kg", /incompatible|cannot convert/i],
    ["5 kg to C", /incompatible|cannot convert/i],
    ["5 foo to km", /unknown unit "foo"/i],
    ["5 km to bar baz", /unknown unit/i],
    ["km to miles", /value|number/i],
    ["5 km", /to|target|convert/i],
    ["5 km to", /to|target|convert/i],
    ["-300 C to K", /absolute zero/i],
    ["100 USD to EUR", /currency/i],
    ["5 dollars to euros", /currency/i],
    ["5 m to __proto__", /unknown unit/i],
    ["5 constructor to km", /unknown unit/i],
    ["1e999 m to km", /too large|finite|number/i],
  ];
  it.each(bad)("%s", (expr, re) => {
    let err: unknown;
    try {
      convertUnits(expr);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CalcError);
    expect((err as Error).message).toMatch(re);
  });
});
