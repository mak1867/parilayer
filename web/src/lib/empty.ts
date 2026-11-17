// Stand-in for Node's "fs" in the browser bundle. The Anchor client references
// fs only in a code path that reads a wallet file from disk, which never runs here.
const empty = {};
export default empty;
