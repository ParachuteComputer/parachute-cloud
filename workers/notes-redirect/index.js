// notes.parachute.computer → my.parachute.computer (301, path+query preserved).
// The legacy Notes host is a broken GitHub-Pages orphan post app-cutover; this
// bounces every old bookmark/PWA/link onto the live app. Points straight at the
// canonical my. origin (my.-canonical Phase 1) rather than app. — avoids a
// notes.→app.→my. double-hop now that app. itself 301s to my.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`https://my.parachute.computer${url.pathname}${url.search}`, 301);
  },
};
