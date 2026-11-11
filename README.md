# `keccak` — the ZKNet anon-rpc worker, by hash

This branch is not code. It is a content store: immutable objects, each named
for the keccak256 of its own bytes, served as an anon-rpc resolver at
`https://raw.githubusercontent.com/ZeroKnowledgeNetwork/zknet/keccak/<hh>/<rest>`. It shares no
history with the source branches, so cloning it costs the objects and nothing else.

## Layout

`<hh>/<rest>`: the first 2 and the remaining 62 of the 64 lowercase hex digits
of `keccak256(bytes)`, with no `0x` and no extension. Anything else here (this
README, `.gitattributes`) is not an object. Nothing is ever removed: a
specifier, or a harness that booted from one, may still name an older hash.

## Contents

| Object | Bytes | What it is |
| --- | --- | --- |
| `56/0a82b56ae9415d2b03919abfdb32f4eab5e553794a88bee839219dc95a3847` | 16430 | `zknet-anon-rpc-worker.js`, built from commit 01d1cf34c4b3cb025384eff9b877a9577fffc779 of this repository |
| `83/fce2db06e49a3bf1d91df098da4603df778c3ba23da31c670f6a6998039ee1` | 23937 | an earlier bundle, kept for the specifiers that pinned it (`live-pin.js`) |
