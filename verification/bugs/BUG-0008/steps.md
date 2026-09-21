# BUG-0008 — steps to reproduce

1. Start the test lab: `bash test-lab/scripts/lab-ctl.sh start`.
   The React banking application is then serving on `http://localhost:4300`. Its sign-in
   form posts to `/api/session` and routes on the client when the response arrives; there
   is no document navigation.
2. Start the AIRA stack (`scripts/services-ctl.sh --with-database`, `api-ctl.sh start`,
   `worker-ctl.sh start`).
3. Register the application with form-login credentials `alice` / `Password123!`:
   `POST /api/v1/applications`.
4. Start discovery: `POST /api/v1/discovery/runs`.
5. Poll `GET /api/v1/discovery/runs/{id}` until it reaches a terminal status.
6. Read the model: `GET /api/v1/applications/{id}/pages` and each page's elements.
7. Look for a page whose route is `/login`, and for the `username`, `password` and
   `login-submit` elements.

Steps 3 to 6 are automated in `reproduce.mjs`, which performs them twice.
