# Pi Fleet

Pi Fleet is a local runtime and machine-first CLI for named Pi agents.

The project is being scaffolded. Its public surface is planned around:

```text
create · send · receive · status · list · watch · destroy
```

Pi Fleet keeps Pi sessions under user control: native Pi launch options pass through after `--`, while Fleet manages named process lifecycle and restoration.

## Development status

No runtime behavior is implemented yet. The next work is a real-Pi compatibility probe and a minimal TypeScript CLI/runtime skeleton.
