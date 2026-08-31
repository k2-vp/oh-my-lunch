// Vite serves a module's own source as a string when the import path ends in
// ?raw. The board test reads board.ts this way to prove the module declares no
// lattice number of its own. This declares the type of that import.
declare module "*?raw" {
  const content: string;
  export default content;
}

// import.meta.glob is a Vite build-time macro. The label test uses it to read
// every module's source at once and prove pretext is imported in one file only.
// This types the one call shape that test uses.
interface ImportMeta {
  glob(
    patterns: string | readonly string[],
    options: { readonly query: "?raw"; readonly eager: true; readonly import: "default" },
  ): Record<string, string>;
}
