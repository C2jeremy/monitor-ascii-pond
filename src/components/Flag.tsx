// National flags as small tiles. Every flag is its own static file, so a page only
// downloads the flags of the countries it shows.
const files = import.meta.glob("/node_modules/country-flag-icons/3x2/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const byCode = new Map(
  Object.entries(files).map(([path, url]) => [/\/([A-Z]{2})\.svg$/.exec(path)?.[1] ?? "", url]),
);
/** Common non-ISO spellings agents report. */
const aliases: Record<string, string> = { UK: "GB", EL: "GR" };

export function flagUrl(country: string | undefined) {
  const code = (country || "").trim().toUpperCase();
  return byCode.get(aliases[code] ?? code) ?? null;
}

export function Flag({ country, className = "" }: { country?: string; className?: string }) {
  const url = flagUrl(country);
  return (
    <span className={"flag " + (url ? "" : "flag-unknown ") + className} aria-hidden="true">
      {url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <b>?</b>}
    </span>
  );
}
