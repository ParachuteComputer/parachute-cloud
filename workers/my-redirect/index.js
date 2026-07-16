// my.parachute.computer → app.parachute.computer (302, path+query preserved).
// This is a NAME CLAIM, not the final topology: Phase A of the ratified
// one-origin consolidation replaces this worker entirely (Custom Domain on
// identity + a my./vault/* zone route on the vault worker), so the redirect
// stays 302 and unconditional — no routing to pre-build here.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`https://app.parachute.computer${url.pathname}${url.search}`, 302);
  },
};
