### Added

- **`checkChangedPaths(changedPaths, allowedPaths)`** also takes a plain list
  of paths, so a host checks a `tests@1` result with
  `checkChangedPaths(result.testPaths, lane.allowedPaths)` instead of wrapping
  it as `{ changedPaths: result.testPaths }`. A refusal's `index` is the
  path's index in the list. Passing a result with `changedPaths` works as
  before.
