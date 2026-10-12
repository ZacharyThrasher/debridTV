// Browser tests import the app's own modules inside page.evaluate (served at /js/*).
// They run in the page, not in Node, so give the compiler a loose shape for them.
declare module "/js/*" {
  const m: any;
  export = m;
}
