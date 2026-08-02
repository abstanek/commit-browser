# Commit Browser

A SourceTree-style commit graph browser for git repositories.

Two views, switched from the toolbar:

- **Graph** - the commit graph across any set of branches, with a details pane
  showing the selected commit's diff
- **Review** - one branch against the branch it would merge into, pull-request
  style: the whole branch diff as a file tree, and a picker to step through the
  branch's individual commits

It comes in two variants that share the frontend (`src/`) and all repository
reading (`gitcore/`):

- a desktop app (`src-tauri/`), which can open any repository via a file dialog
- a web server (`src-server/`), which serves the same UI over HTTP for one
  repository chosen on the command line

The two differ only in `src/backend-{tauri,web}.ts`, selected by Vite's `--mode`.

## Desktop app

```
npm install
npm run tauri dev      # or: npm run tauri build
```

## Web server

Build the frontend and run the server against a repository:

```
npm install
npm run build:web
cargo build --release -p commit-browser-server
./target/release/commit-browser-server --repo /path/to/repo
```

Then open <http://127.0.0.1:4600>.

The server binds loopback, so from a workstation reach a remote dev machine
through an SSH tunnel:

```
ssh -L 4600:127.0.0.1:4600 devbox
```

There is no authentication and no way to open a different repository over HTTP;
`--host 0.0.0.0` gives anyone who can reach the port read access to the
repository, including its full history and diffs.

Options: `--repo`, `--host`, `--port`, `--static-dir` (defaults to the
`dist-web/` of the source tree the binary was built from).

### Developing the web variant

Run the server for the API and Vite for the frontend; Vite proxies `/api` to the
server on port 4600:

```
npm run server -- --repo /path/to/repo
npm run dev:web        # http://localhost:1421
```
