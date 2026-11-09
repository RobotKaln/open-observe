// Web entry (Metro picks this instead of index.ts on web): a real collector instead of the empty web module of expo-observe.
// It is `.ts` and not `.tsx` on purpose: for each extension Metro tries the platform file first, so `index.web.tsx` would lose
// to `index.ts`. The implementation (JSX) is in web/observe.tsx.
export * from './web/observe';
export { default } from './web/observe';
