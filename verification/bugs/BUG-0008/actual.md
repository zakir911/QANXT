# BUG-0008 — actual

```
pages discovered:        10
/login among them:       false
username in the model:   false
password in the model:   false
login-submit in model:   false
page recall vs ground truth: 88.9% (8 of 9)
```

Both attempts, identical. The crawl visits the sign-in page — it has to, in order to sign
in — and discards what it saw.
