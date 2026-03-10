export const DEFAULT_ORG = "XRPLF";

export const REPOS: { owner: string; name: string }[] = [
  "rippled",
  "xrpl.js",
  "xrpl-py",
  "xrpl-dev-portal",
  "clio",
  "XRPL-Standards",
  "xrpl4j",
  "ripple/opensource.ripple.com",
].map((r) => {
  const parts = r.split("/");
  return parts.length === 2
    ? { owner: parts[0], name: parts[1] }
    : { owner: DEFAULT_ORG, name: r };
});

export const CONCURRENCY = 2;
