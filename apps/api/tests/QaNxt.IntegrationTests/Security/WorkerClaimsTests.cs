using FluentAssertions;
using Microsoft.Extensions.Primitives;
using QaNxt.Api.Authorization;

namespace QaNxt.IntegrationTests.Security;

/// <summary>Which rate-limit bucket a request belongs in, read from what its token claims.
///
/// This exists because of a failure that hid another failure. A worker's job token expires
/// while its job waits in the queue; the token then authenticates to nothing, so the
/// validated principal is empty and the callback falls into the general per-address
/// bucket, which a fleet exhausts in seconds. The worker receives 429 — and it exchanges
/// an expired token for a fresh one only when it is told 401. The limiter was hiding the
/// one signal that would have repaired the run, and 992 executions retried into it until
/// the stranded sweep ended them.</summary>
public class WorkerClaimsTests
{
    /// <summary>A JWT's middle segment is base64url-encoded JSON. Nothing here signs it,
    /// which is the point: this reads a claim, it does not believe one.</summary>
    private static StringValues Bearer(string payloadJson)
    {
        var body = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(payloadJson))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        return new StringValues($"Bearer header.{body}.signature");
    }

    [Fact]
    public void An_expired_worker_token_is_still_recognised_as_a_worker()
    {
        // The whole point: expiry is irrelevant to which traffic class this is.
        var claimed = WorkerClaims.ReadUnvalidated(
            Bearer("""{"kind":"worker","org":"1a2b3c","exp":1}"""));

        claimed.IsWorker.Should().BeTrue();
        claimed.OrganizationId.Should().Be("1a2b3c");
    }

    [Fact]
    public void A_user_token_is_not_a_worker()
    {
        WorkerClaims.ReadUnvalidated(Bearer("""{"kind":"user","org":"1a2b3c"}"""))
            .IsWorker.Should().BeFalse();
    }

    [Fact]
    public void A_worker_token_with_no_organization_is_still_a_worker()
    {
        // It gets the shared "unknown" worker bucket rather than a tenant's user budget.
        var claimed = WorkerClaims.ReadUnvalidated(Bearer("""{"kind":"worker"}"""));

        claimed.IsWorker.Should().BeTrue();
        claimed.OrganizationId.Should().BeNull();
    }

    [Theory]
    [InlineData("")]
    [InlineData("Bearer")]
    [InlineData("Bearer not-a-jwt")]
    [InlineData("Bearer one.two")]
    [InlineData("Bearer a.!!!not-base64!!!.c")]
    [InlineData("Basic dXNlcjpwYXNz")]
    public void Anything_unreadable_is_simply_not_a_worker(string header)
    {
        WorkerClaims.ReadUnvalidated(new StringValues(header)).IsWorker.Should().BeFalse();
    }

    [Fact]
    public void A_payload_that_is_valid_base64_but_not_an_object_is_not_a_worker()
    {
        WorkerClaims.ReadUnvalidated(Bearer("\"just a string\"")).IsWorker.Should().BeFalse();
    }

    [Fact]
    public void A_missing_header_is_not_a_worker()
    {
        WorkerClaims.ReadUnvalidated(StringValues.Empty).IsWorker.Should().BeFalse();
    }

    [Fact]
    public void Reading_a_claim_is_not_believing_it()
    {
        // A forged claim buys a different rate bucket and nothing else: every bucket is
        // bounded and the endpoints still demand a validated token. This test records that
        // the method makes no authorisation statement, so nobody later reaches for it as
        // though it did.
        var forged = WorkerClaims.ReadUnvalidated(
            Bearer("""{"kind":"worker","org":"somebody-elses-org","perm":["admin"]}"""));

        forged.IsWorker.Should().BeTrue("classification is all this does");
        forged.OrganizationId.Should().Be("somebody-elses-org",
            "which is why the result may only choose a bounded bucket, never grant access");
    }
}
