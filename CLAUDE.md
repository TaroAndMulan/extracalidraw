# CLAUDE.md

## Project Structure

Excalidraw is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw/common`, `@excalidraw/element`, `@excalidraw/math`, `@excalidraw/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Workflow

1. **Package Development**: Work in `packages/*` for editor features
2. **App Development**: Work in `excalidraw-app/` for app-specific features
3. **Testing**: Always run `yarn test:update` before committing
4. **Type Safety**: Use `yarn test:typecheck` to verify TypeScript

## Development Commands

```bash
yarn test:typecheck  # TypeScript type checking
yarn test:update     # Run all tests (with snapshot updates)
yarn fix             # Auto-fix formatting and linting issues
```

## Architecture Notes

### Package System

- Uses Yarn workspaces for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration

## Self-hosted whiteboard (this fork)

This fork adds a self-hosted multi-user whiteboard (accounts, papers with pages, real-time collaboration, embeds):

- **Code**: `whiteboard-server/` (Node.js server), `whiteboard-app/` (React app using `packages/excalidraw`), `deploy/` (Docker Compose + Caddy). `excalidraw-app/` is unchanged; `packages/` only gained partial text colors (`colorRanges`, see `docs/whiteboard/decisions.md` → "Changes to packages/").
- **Read first**: [`docs/whiteboard/README.md`](./docs/whiteboard/README.md) (architecture, protocol, testing, decisions). User docs: [`WHITEBOARD.md`](./WHITEBOARD.md).
- **Checks**: `yarn vitest run whiteboard-server` (server unit + integration tests), `yarn test:typecheck` (also runs `tsc -p whiteboard-server`), and the browser smoke test `yarn whiteboard:e2e <url> <admin> <password>` against a running server.
