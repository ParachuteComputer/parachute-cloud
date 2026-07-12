// notes.parachute.computer → app.parachute.computer (301, path+query preserved).
// The legacy Notes host is a broken GitHub-Pages orphan post app-cutover; this
// bounces every old bookmark/PWA/link onto the live app.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`https://app.parachute.computer${url.pathname}${url.search}`, 301);
  },
};
