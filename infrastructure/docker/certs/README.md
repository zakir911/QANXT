# Extra CA certificates

Drop a PEM-encoded `.crt` file here to have it trusted during the image builds.

Many corporate networks terminate TLS at an inspecting proxy, which makes every package
restore fail with a certificate error that says nothing useful about the cause. Putting that
proxy's CA here is the supported way to build behind one.

Files in this directory other than this README are ignored by git: a certificate is
environment-specific, and one committed here would be trusted by everybody's build.
