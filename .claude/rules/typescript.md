# TypeScript

`tsconfig.base.json` is law: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `erasableSyntaxOnly`, Node16 ESM, `lib: ["ES2023"]`.

- `packages/core/tsconfig.json` adds `"types": []`: no Node and no DOM types in core.
- `import type` for types. Named exports from packages. No `any`, no empty `catch`.
- No default exports from libraries. Exhaustive `switch` on unions (`never`).
- Omit optional keys; do not assign `undefined` into `exactOptionalPropertyTypes` fields.
- Explicit return types on exported ports and domain functions.
- `.ts` import extensions. Expected failures are result unions (`{ ok: false, … }`); throw only for programming
  errors.
- Scripts are `.mjs` with JSDoc types, checked with `checkJs` (`tsc -p scripts`).
