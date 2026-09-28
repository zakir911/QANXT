using QaNxt.Domain.Common;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Security;

/// <summary>
/// The error codes are a contract with the CLI, which turns them into exit statuses that
/// pipelines branch on. A rename here is a breaking change for every pipeline already
/// keying off the code it produces, so the codes are pinned rather than left implicit.
/// </summary>
public class ErrorCodeTests
{
    [Fact]
    public void A_security_policy_refusal_is_not_the_same_code_as_a_permission_refusal()
    {
        // BUG-0026: both were "forbidden", so the CLI had only the 403 status to go on and
        // reported a policy refusal as an authentication failure. A pipeline reading that
        // widens its service account's permissions, which cannot change the answer and
        // removes a control that just worked.
        Error.SecurityPolicy("Testing production has not been authorized.").Code
            .Should().NotBe(Error.Forbidden().Code);
    }

    [Fact]
    public void A_security_policy_refusal_keeps_its_wire_code()
    {
        Error.SecurityPolicy("refused").Code.Should().Be("security_policy");
    }

    [Fact]
    public void A_security_policy_refusal_is_still_a_403()
    {
        // The server understood the request and refuses it. Signing in again will not
        // help, so 401 would be wrong; the request was well-formed, so 400 would be too.
        Error.SecurityPolicy("refused").Kind.Should().Be(ErrorKind.Forbidden);
    }

    [Fact]
    public void A_security_policy_refusal_carries_the_reason_through()
    {
        // A pipeline that is refused has to be able to print why without a second call.
        const string reason = "Environment 'prod' is production and testing it has not been authorized.";
        Error.SecurityPolicy(reason).Message.Should().Be(reason);
    }
}
