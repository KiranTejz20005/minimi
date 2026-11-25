import { CalcError, excerpt, formatNumber, type CalcOutput } from "./errors.js";

/**
 * Unit conversion. Every non-temperature unit is a factor to its dimension's base unit; temperature is affine
 * (via kelvin). Names are looked up in exact-case tables first (so MB/Mb/mB-style data units stay distinct),
 * then case-insensitively. Unknown or cross-dimension conversions are errors; nothing is guessed.
 */

type Dim = "length" | "mass" | "volume" | "speed" | "area" | "time" | "data" | "energy" | "pressure" | "temperature";
type Unit = { dim: Dim; factor: number; label: string };

const exact = new Map<string, Unit>();
const ci = new Map<string, Unit>();

function add(dim: Dim, label: string, factor: number, ciNames: string[], exactNames: string[] = []): void {
  const u: Unit = { dim, factor, label };
  for (const n of ciNames) ci.set(n.toLowerCase(), u);
  for (const n of exactNames) exact.set(n, u);
}

// length (base: metre)
add("length", "m", 1, ["m", "meter", "meters", "metre", "metres"]);
add("length", "km", 1000, ["km", "kilometer", "kilometers", "kilometre", "kilometres"]);
add("length", "cm", 0.01, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]);
add("length", "mm", 0.001, ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]);
add("length", "um", 1e-6, ["um", "µm", "μm", "micron", "microns", "micrometer", "micrometers"]);
add("length", "nm", 1e-9, ["nm", "nanometer", "nanometers"]);
add("length", "mi", 1609.344, ["mi", "mile", "miles"]);
add("length", "yd", 0.9144, ["yd", "yds", "yard", "yards"]);
add("length", "ft", 0.3048, ["ft", "foot", "feet"]);
add("length", "in", 0.0254, ["in", "inch", "inches"]);
add("length", "nmi", 1852, ["nmi", "nautical mile", "nautical miles"]);

// mass (base: kilogram)
add("mass", "kg", 1, ["kg", "kilogram", "kilograms", "kilo", "kilos"]);
add("mass", "g", 0.001, ["g", "gram", "grams"]);
add("mass", "mg", 1e-6, ["mg", "milligram", "milligrams"]);
add("mass", "ug", 1e-9, ["ug", "µg", "μg", "mcg", "microgram", "micrograms"]);
add("mass", "t", 1000, ["t", "tonne", "tonnes", "metric ton", "metric tons"]);
add("mass", "lb", 0.45359237, ["lb", "lbs", "pound", "pounds"]);
add("mass", "oz", 0.028349523125, ["oz", "ounce", "ounces"]);
add("mass", "st", 6.35029318, ["st", "stone", "stones"]);
add("mass", "ton (US short)", 907.18474, ["ton", "tons", "short ton", "short tons", "us ton"]);
add("mass", "long ton", 1016.0469088, ["long ton", "long tons", "uk ton"]);

// volume (base: litre)
add("volume", "L", 1, ["l", "liter", "liters", "litre", "litres"]);
add("volume", "ml", 0.001, ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"]);
add("volume", "cl", 0.01, ["cl", "centiliter", "centiliters"]);
add("volume", "dl", 0.1, ["dl", "deciliter", "deciliters"]);
add("volume", "m3", 1000, ["m3", "m^3", "cubic meter", "cubic meters", "cubic metre", "cubic metres"]);
add("volume", "gal (US)", 3.785411784, ["gal", "gallon", "gallons", "us gallon", "us gallons"]);
add("volume", "qt (US)", 0.946352946, ["qt", "quart", "quarts"]);
add("volume", "pt (US)", 0.473176473, ["pt", "pint", "pints"]);
add("volume", "cup (US)", 0.2365882365, ["cup", "cups"]);
add("volume", "fl oz (US)", 0.0295735295625, ["fl oz", "floz", "fl. oz", "fluid ounce", "fluid ounces"]);
add("volume", "tbsp", 0.01478676478125, ["tbsp", "tablespoon", "tablespoons"]);
add("volume", "tsp", 0.00492892159375, ["tsp", "teaspoon", "teaspoons"]);
add("volume", "gal (imperial)", 4.54609, ["imperial gallon", "imperial gallons", "imp gal", "uk gallon", "uk gallons"]);
add("volume", "pt (imperial)", 0.56826125, ["imperial pint", "imperial pints", "imp pt", "uk pint", "uk pints"]);
add("volume", "ft3", 28.316846592, ["ft3", "ft^3", "cubic foot", "cubic feet"]);

// speed (base: m/s)
add("speed", "m/s", 1, ["m/s", "mps", "meters per second", "metres per second", "meter per second"]);
add("speed", "km/h", 1000 / 3600, ["km/h", "kmh", "kph", "kmph", "kilometers per hour", "kilometres per hour"]);
add("speed", "mph", 1609.344 / 3600, ["mph", "mi/h", "miles per hour", "mile per hour"]);
add("speed", "ft/s", 0.3048, ["ft/s", "fps", "feet per second"]);
add("speed", "knot", 1852 / 3600, ["kn", "kt", "kts", "knot", "knots"]);

// area (base: m2)
add("area", "m2", 1, ["m2", "m^2", "sq m", "square meter", "square meters", "square metre", "square metres"]);
add("area", "km2", 1e6, ["km2", "km^2", "sq km", "square kilometer", "square kilometers", "square kilometre"]);
add("area", "cm2", 1e-4, ["cm2", "cm^2", "sq cm", "square centimeter", "square centimeters"]);
add("area", "mm2", 1e-6, ["mm2", "mm^2", "sq mm", "square millimeter", "square millimeters"]);
add("area", "ha", 10_000, ["ha", "hectare", "hectares"]);
add("area", "acre", 4046.8564224, ["acre", "acres"]);
add("area", "ft2", 0.09290304, ["ft2", "ft^2", "sq ft", "square foot", "square feet"]);
add("area", "in2", 0.00064516, ["in2", "in^2", "sq in", "square inch", "square inches"]);
add("area", "yd2", 0.83612736, ["yd2", "yd^2", "sq yd", "square yard", "square yards"]);
add("area", "mi2", 2589988.110336, ["mi2", "mi^2", "sq mi", "square mile", "square miles"]);

// time (base: second). month = 1/12 Gregorian year, year = 365.2425 days
add("time", "ns", 1e-9, ["ns", "nanosecond", "nanoseconds"]);
add("time", "us", 1e-6, ["us", "µs", "μs", "microsecond", "microseconds"]);
add("time", "ms", 0.001, ["ms", "millisecond", "milliseconds"]);
add("time", "s", 1, ["s", "sec", "secs", "second", "seconds"]);
add("time", "min", 60, ["min", "mins", "minute", "minutes"]);
add("time", "h", 3600, ["h", "hr", "hrs", "hour", "hours"]);
add("time", "day", 86400, ["d", "day", "days"]);
add("time", "week", 604800, ["wk", "wks", "week", "weeks"]);
add("time", "month", 2629746, ["mo", "month", "months"]);
add("time", "year", 31556952, ["y", "yr", "yrs", "year", "years"]);

// data (base: byte). Exact-case entries win: Mb = megabit, MB = megabyte. Lowercase kb/mb/gb... read as bytes.
add("data", "bit", 1 / 8, ["bit", "bits"], ["b"]);
add("data", "byte", 1, ["byte", "bytes"], ["B"]);
const dec: [string, string, number][] = [["k", "kilo", 1e3], ["M", "mega", 1e6], ["G", "giga", 1e9], ["T", "tera", 1e12], ["P", "peta", 1e15]];
for (const [p, word, f] of dec) {
  const lp = p.toLowerCase();
  add("data", `${p}B`, f, [`${lp}b`, `${word}byte`, `${word}bytes`], [`${p}B`, `${p.toUpperCase()}B`]);
  add("data", `${p}b`, f / 8, [`${word}bit`, `${word}bits`], [`${p.toUpperCase()}b`, `${lp}bit`, `${lp}bits`]);
}
const bin: [string, string, number][] = [["Ki", "kibi", 1024], ["Mi", "mebi", 1024 ** 2], ["Gi", "gibi", 1024 ** 3], ["Ti", "tebi", 1024 ** 4], ["Pi", "pebi", 1024 ** 5]];
for (const [p, word, f] of bin) {
  add("data", `${p}B`, f, [`${p}B`, `${word}byte`, `${word}bytes`]);
}

// energy (base: joule)
add("energy", "J", 1, ["j", "joule", "joules"]);
add("energy", "kJ", 1000, ["kj", "kilojoule", "kilojoules"]);
add("energy", "MJ", 1e6, ["mj", "megajoule", "megajoules"]);
add("energy", "cal", 4.184, ["cal", "calorie", "calories"]);
add("energy", "kcal", 4184, ["kcal", "kilocalorie", "kilocalories"], ["Cal"]);
add("energy", "Wh", 3600, ["wh", "watt hour", "watt hours"]);
add("energy", "kWh", 3.6e6, ["kwh", "kilowatt hour", "kilowatt hours"]);
add("energy", "MWh", 3.6e9, ["mwh", "megawatt hour", "megawatt hours"]);
add("energy", "BTU", 1055.05585262, ["btu", "btus"]);
add("energy", "eV", 1.602176634e-19, ["ev", "electronvolt", "electronvolts"]);

// pressure (base: pascal)
add("pressure", "Pa", 1, ["pa", "pascal", "pascals"]);
add("pressure", "hPa", 100, ["hpa", "hectopascal", "hectopascals"]);
add("pressure", "kPa", 1000, ["kpa", "kilopascal", "kilopascals"]);
add("pressure", "MPa", 1e6, ["mpa", "megapascal", "megapascals"]);
add("pressure", "bar", 1e5, ["bar", "bars"]);
add("pressure", "mbar", 100, ["mbar", "millibar", "millibars"]);
add("pressure", "atm", 101325, ["atm", "atmosphere", "atmospheres"]);
add("pressure", "psi", 6894.757293168, ["psi"]);
add("pressure", "mmHg", 133.322387415, ["mmhg"]);
add("pressure", "torr", 101325 / 760, ["torr"]);
add("pressure", "inHg", 3386.389, ["inhg"]);

// temperature (affine; factor unused)
const TEMP = new Map<string, "C" | "F" | "K">(Object.entries({
  c: "C", celsius: "C", centigrade: "C", degc: "C",
  f: "F", fahrenheit: "F", degf: "F",
  k: "K", kelvin: "K", kelvins: "K", degk: "K",
} as Record<string, "C" | "F" | "K">));

const CURRENCY = new Set([
  "usd", "eur", "gbp", "inr", "jpy", "cny", "aud", "cad", "chf", "mxn", "brl", "krw", "sgd", "hkd", "nzd", "rub", "zar", "aed",
  "dollar", "dollars", "euro", "euros", "pound sterling", "rupee", "rupees", "yen", "yuan", "peso", "pesos", "$", "€", "£", "₹", "¥",
]);

function normalizeUnit(raw: string): string {
  return raw
    .trim()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "");
}

function stripDegree(s: string): string {
  return s.replace(/^(?:°|º|degrees?\s+|deg\s*)/i, "");
}

type Resolved = { dim: Dim; label: string; factor: number; temp?: "C" | "F" | "K" };

function resolveUnit(raw: string): Resolved {
  const name = normalizeUnit(raw);
  if (!name) throw new CalcError("missing unit");
  const lower = name.toLowerCase();

  const hit = exact.get(name) ?? ci.get(lower) ?? (lower.length > 3 && lower.endsWith("s") ? ci.get(lower.slice(0, -1)) : undefined);
  if (hit) return hit;

  const t = TEMP.get(stripDegree(lower));
  if (t) return { dim: "temperature", label: t === "K" ? "K" : `°${t}`, factor: 1, temp: t };

  if (CURRENCY.has(lower)) {
    throw new CalcError(
      `currency conversion is not supported (exchange rates change); use the convert_currency tool for current rates ("${excerpt(name)}")`,
    );
  }
  throw new CalcError(`unknown unit "${excerpt(name)}"`);
}

function toKelvin(v: number, u: "C" | "F" | "K"): number {
  return u === "C" ? v + 273.15 : u === "F" ? ((v - 32) * 5) / 9 + 273.15 : v;
}
function fromKelvin(k: number, u: "C" | "F" | "K"): number {
  return u === "C" ? k - 273.15 : u === "F" ? ((k - 273.15) * 9) / 5 + 32 : k;
}

const NUM = /^([+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/;
const SEP = /^(.+)\s+(?:to|in|into|as|->)\s+(.*)$/i;
const SEP_EMPTY = /\s(?:to|in|into|as|->)\s*$/i;

/** Convert "<number> <unit> to <unit>". */
export function convertUnits(input: string): CalcOutput {
  const src = input.replace(/\s+/g, " ").trim();
  if (!src) throw new CalcError("empty expression");
  if (src.length > 200) throw new CalcError("expression is too long for a unit conversion");

  const sep = SEP.exec(src);
  if (!sep) {
    throw new CalcError(
      SEP_EMPTY.test(src)
        ? "missing target unit after 'to'"
        : 'expected the form "<number> <unit> to <unit>", e.g. "5 miles to km"',
    );
  }
  const left = sep[1]!;
  const targetRaw = sep[2]!.trim();
  if (!targetRaw) throw new CalcError("missing target unit after 'to'");

  const m = NUM.exec(left);
  if (!m) throw new CalcError('missing value: start with a number, e.g. "5 miles to km"');
  const value = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) throw new CalcError("number too large");
  const fromRaw = m[2]!.trim();
  if (!fromRaw) throw new CalcError('missing source unit, e.g. "5 miles to km"');

  const from = resolveUnit(fromRaw);
  const to = resolveUnit(targetRaw);
  if (from.dim !== to.dim) {
    throw new CalcError(`cannot convert ${from.dim} (${from.label}) to ${to.dim} (${to.label}): incompatible units`);
  }

  let out: number;
  if (from.dim === "temperature") {
    const k = toKelvin(value, from.temp!);
    if (k < -1e-9) throw new CalcError("temperature is below absolute zero");
    out = fromKelvin(k, to.temp!);
  } else {
    out = (value * from.factor) / to.factor;
  }
  const result = formatNumber(out);
  return { result, text: `${formatNumber(value)} ${fromRaw} = ${result} ${targetRaw}` };
}
