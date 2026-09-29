# osu!web

## Local development

Build and serve with the required cross-origin isolation headers:

```sh
./build.sh
node tools/serve.mjs dist/wwwroot 8080
```

Then open <http://localhost:8080>.

## Vercel

The repository-root [`vercel.json`](../vercel.json) is ready for Git or CLI deployments. It:

- installs the pinned .NET 10 SDK and WebAssembly workload;
- fetches the pinned osu!framework revision and applies `patches/osu-framework-web.patch`;
- builds the browser client;
- serves the COOP/COEP headers required by WebAssembly threads;
- proxies approved `ppy.sh` endpoints through `/api/proxy`, which sets `User-Agent: osu!` (the site rejects other clients, and the browser will not let the game set that header itself).

Deploy from the repository root:

```sh
npx vercel
npx vercel --prod
```

No environment variables are required. Keep Vercel's project **Root Directory** set to the repository root. The first deployment downloads the .NET SDK/workload and may take several minutes.

The generated site is large because `osu.Game.Resources` embeds the game's assets. `vercel-build.sh` removes redundant gzip/Brotli sidecars and relies on Vercel CDN compression.

### Updating the framework patch

The deployment build starts from framework revision `247dee9888c51606b939f027bce54504f8ca26fa`. If the local framework backend changes, regenerate `patches/osu-framework-web.patch` from the matching checkout before deploying.
