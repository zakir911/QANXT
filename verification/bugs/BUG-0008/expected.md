# BUG-0008 — expected

The application model contains the sign-in page:

- a page with route `/login`, `requiresAuthentication: false`;
- its elements — `username`, `password`, `login-submit`, `remember-me`, `forgot-password`
  — with preferred locators, like any other page's elements;
- page recall against the ground truth of 1.0 (nine declared pages, nine found).

Capturing it must not change the sign-in itself: the crawl still authenticates, and a run
with wrong credentials still fails.
