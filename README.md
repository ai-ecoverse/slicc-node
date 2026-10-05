# slicc-node

Empty package for SLICC's Node local proxy. The kernel in the page on `*.sliccy.ai` will talk to this process through a proxy key. Migrate from SLICC's `packages/node-server`.

```js
import {} from '@ai-ecoverse/slicc-node';
```

```bash
npx slicc-node
```

Node ≥ 24. `npm run lint` runs `slicc-lint`. Releases use semantic-release on `main`.
