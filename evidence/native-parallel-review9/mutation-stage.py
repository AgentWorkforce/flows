"""Create scratch dist variants for review-8 F1/F2 revert proofs inside /w."""

from pathlib import Path
import shutil

root = Path('/w')
head = root / 'sdk-head'


def side(name: str) -> Path:
    sdk = root / name / 'packages/sdk'
    shutil.rmtree(sdk, ignore_errors=True)
    sdk.mkdir(parents=True)
    shutil.copytree(head / 'dist', sdk / 'dist')
    shutil.copy2(head / 'package.json', sdk / 'package.json')
    (sdk / 'node_modules').symlink_to(root / 'node_modules')
    return sdk / 'dist'


def replace(path: Path, before: str, after: str, count: int = 1) -> None:
    source = path.read_text()
    found = source.count(before)
    assert found == count, (path, before, found, count)
    path.write_text(source.replace(before, after))


def without_array_gate(path: Path) -> None:
    source = path.read_text()
    guards = [
        "|| !sameDescriptor(Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator), nativeArrayIteratorDescriptor)",
        "|| Array.prototype[Symbol.iterator] !== nativeArrayIterator",
        "|| !sameDescriptor(Object.getOwnPropertyDescriptor(nativeArrayIteratorPrototype, 'next'), nativeArrayIteratorNextDescriptor)",
        "|| nativeArrayIteratorPrototype.next !== nativeArrayIteratorNext",
    ]
    for guard in guards:
        assert source.count(guard) == 1, guard
        source = source.replace(guard, '|| false')
    path.write_text(source)


# F1a: restore the regex that falsely called benign --*-r* flags preloads.
dist = side('fx')
path = dist / 'authored-flow-lifecycle.js'
source = path.read_text()
start = source.index('function authoredProcessHasPreload() {')
end = source.index('/** NODE_OPTIONS is a command-line string', start)
source = source[:start] + '''function authoredProcessHasPreload() {
    const preload = /--(?:import|require|loader|experimental-loader)(?:=|\\s|$)|-r(?:=|\\s|\\S)/u;
    return process.execArgv.some(arg => preload.test(arg))
        || preload.test(process.env['NODE_OPTIONS'] ?? '');
}
''' + source[end:]
path.write_text(source)

# F1b: remove only the pre-dispatch pinned-root check.
dist = side('m1')
replace(dist / 'authored-root.js', '    assertParallelResumeRuntime(metadata, rootRunId);', '    void 0;', 2)

# F2a: keep the settlement backstop, but disable the Array iterator admission gate.
dist = side('m3')
without_array_gate(dist / 'authored-flow-lifecycle.js')

# F2b: remove that backstop too. The iterator attack can now replay effects.
dist = side('m2')
path = dist / 'authored-flow-lifecycle.js'
without_array_gate(path)
replace(path, 'return this.hasInvalidAllSettlement()', 'return false')

print('Created fx (old F1 parser), m1 (no F1 resume guard),')
print('m3 (F2 backstop only), and m2 (no Array gate or F2 backstop).')
