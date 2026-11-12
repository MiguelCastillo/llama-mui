// Lets TypeScript accept Vite's "?url" imports (a file's built address as a string).
declare module "*?url" {
  const url: string;
  export default url;
}
