// app.parachute.computer → my.parachute.computer (301, path+query preserved).
// my.-canonical Phase 1: my. is the ONE advertised human origin. app. is still a
// co-equal SPA Custom Domain on the identity worker, but a Custom Domain only
// route-matches `/` at the worker — every DEEP SPA path (/n/…, /settings, /tags)
// is served by the Static-Assets runtime and never reaches the worker, so an
// in-worker `/`-only redirect would leave deep app. links serving the stale
// origin. A ZONE ROUTE (app.parachute.computer/*) on THIS tiny worker takes
// precedence over that Custom Domain (CF "Interaction with Routes"), so it
// intercepts EVERY app. request — root and deep — at the platform layer and
// 301s it to the same path on my. The token issuer is UNCHANGED (cloud.); this
// is an advertised-origin move only.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`https://my.parachute.computer${url.pathname}${url.search}`, 301);
  },
};
