# GitDiff

GitDiff is a VS Code extension for file-focused Git comparison.

It helps you compare the currently active file against commit history in a fast, visual workflow.

## Features

- Compare the current file against `HEAD` (working tree on the right side)
- Compare the current file against any selected revision
- Compare two selected revisions of the same file directly
- Click file history items to inspect commit-level changes (`commit` vs `commit^`)
- Sidebar workflow designed for file-first diff navigation
- Optional GitLab-like diff color themes
- Chinese / English UI toggle in sidebar

## Quick Start

1. Open a file inside a Git repository.
2. Open the **GitDiff** activity bar view.
3. Choose one of the compare actions:
   - Pick a commit from file history
   - Compare two selected revisions
   - Use context menu commands in editor/explorer

## Commands

- `GitDiff: 与 HEAD 比较（工作区）`
- `GitDiff: 与指定版本比较（工作区在右侧）`
- `GitDiff: 比较两个历史版本`
- `GitDiff: 打开比较侧边栏`

## Requirements

- VS Code `^1.85.0`
- Git available in PATH

## Extension Settings

This extension currently does not require mandatory user settings.

## Known Issues

- For extremely large files or binary files, diff rendering performance depends on VS Code built-in diff editor behavior.
- If file path does not exist in the selected revision, compare will show an error prompt.

## Release Notes

See [CHANGELOG.md](./CHANGELOG.md).

## Publish Checklist (Maintainer)

Before publishing to Marketplace:

1. Replace `publisher` in `package.json` with your real Marketplace publisher id.
2. Update metadata URLs (`repository`, `homepage`, `bugs`) to your real repo.
3. Run:

```bash
npm run install-deps
npm run compile
npm run package:vsce
```

4. Login and publish:

```bash
npx @vscode/vsce login <your-publisher>
npx @vscode/vsce publish
```

## License

MIT
