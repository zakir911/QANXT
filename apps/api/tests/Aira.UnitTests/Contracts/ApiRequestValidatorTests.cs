using Aira.Application.Contracts;
using Aira.Domain.Enums;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Contracts;

/// <summary>The gate between an authored — or AI-proposed — HTTP request and a real
/// application. Every refusal it promises is asserted here, because each one is something
/// that cannot be enforced later: a method outside the set, a path that leaves the
/// authorization boundary, a credential written into a test instead of referenced.</summary>
public class ApiRequestValidatorTests
{
    private static BrowserActionPolicy Policy()
        => new(AllowScriptExecution: false, AllowXPathLocators: true, (string url, out string reason) =>
        {
            reason = "the host is not in this project's allowlist";
            return url.StartsWith("https://api.example.com", StringComparison.Ordinal);
        });

    private static ApiRequestDescriptor Get(string path = "/api/accounts") =>
        new() { Method = "GET", Path = path };

    [Fact]
    public void Accepts_a_well_formed_relative_request()
    {
        ApiRequestValidator.Validate(Get(), Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Accepts_an_absolute_url_inside_the_boundary()
    {
        var request = Get("https://api.example.com/v1/accounts");
        ApiRequestValidator.Validate(request, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Rejects_an_absolute_url_outside_the_boundary()
    {
        var request = Get("https://evil.example.net/v1/accounts");
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("not allowed"));
    }

    [Theory]
    [InlineData("TRACE")]
    [InlineData("CONNECT")]
    [InlineData("PROPFIND")]
    [InlineData("")]
    public void Rejects_a_method_outside_the_closed_set(string method)
    {
        var result = ApiRequestValidator.Validate(Get() with { Method = method }, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("not a supported HTTP method"));
    }

    [Fact]
    public void Rejects_a_relative_path_that_does_not_start_with_a_slash()
    {
        var result = ApiRequestValidator.Validate(Get("api/accounts"), Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("must start with '/'"));
    }

    [Fact]
    public void Rejects_an_empty_path()
    {
        var result = ApiRequestValidator.Validate(Get(string.Empty), Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("requires a path"));
    }

    [Theory]
    [InlineData("host")]
    [InlineData("Content-Length")]
    [InlineData("connection")]
    [InlineData("Transfer-Encoding")]
    public void Rejects_headers_the_engine_owns(string name)
    {
        var request = Get() with { Headers = new Dictionary<string, string> { [name] = "anything" } };
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("set by the execution engine"));
    }

    [Fact]
    public void Rejects_a_header_value_containing_a_line_break()
    {
        // Header injection: a value carrying CRLF could append headers of its own.
        var request = Get() with
        {
            Headers = new Dictionary<string, string> { ["x-trace"] = "abc\r\nx-admin: true" }
        };
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("line break"));
    }

    [Fact]
    public void Rejects_a_literal_credential_in_a_header()
    {
        var request = Get() with
        {
            Headers = new Dictionary<string, string> { ["authorization"] = "Bearer sk_live_abc123" }
        };
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("literal credential"));
    }

    [Fact]
    public void Accepts_a_secret_reference_in_a_header()
    {
        var request = Get() with
        {
            Headers = new Dictionary<string, string> { ["authorization"] = "${secret:api_token}" }
        };
        ApiRequestValidator.Validate(request, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Rejects_a_literal_credential_in_the_body()
    {
        var request = Get() with { Method = "POST", Body = "{\"password=\": \"hunter2\"}" };
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("literal credential"));
    }

    [Fact]
    public void Requires_a_bearer_token_to_be_a_reference_rather_than_a_literal()
    {
        var literal = Get() with
        {
            Auth = new ApiAuthDescriptor { Mode = ApiAuthMode.Bearer, Token = "eyJhbGciOiJIUzI1NiJ9.abc" }
        };
        var reference = Get() with
        {
            Auth = new ApiAuthDescriptor { Mode = ApiAuthMode.Bearer, Token = "${secret:api_token}" }
        };

        ApiRequestValidator.Validate(literal, Policy()).Errors
            .Should().Contain(e => e.Contains("must be a ${secret:name} reference"));
        ApiRequestValidator.Validate(reference, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Requires_an_api_key_to_be_named_and_referenced()
    {
        var missingName = Get() with
        {
            Auth = new ApiAuthDescriptor { Mode = ApiAuthMode.ApiKeyHeader, KeyValue = "${secret:key}" }
        };
        var literalValue = Get() with
        {
            Auth = new ApiAuthDescriptor { Mode = ApiAuthMode.ApiKeyHeader, KeyName = "X-API-Key", KeyValue = "abc123" }
        };

        ApiRequestValidator.Validate(missingName, Policy()).Errors
            .Should().Contain(e => e.Contains("name of the header or query parameter"));
        ApiRequestValidator.Validate(literalValue, Policy()).Errors
            .Should().Contain(e => e.Contains("must be a ${secret:name} reference"));
    }

    [Fact]
    public void Rejects_an_oauth_token_endpoint_outside_the_boundary()
    {
        var request = Get() with
        {
            Auth = new ApiAuthDescriptor
            {
                Mode = ApiAuthMode.OAuth2ClientCredentials,
                TokenUrl = "https://idp.elsewhere.example/oauth/token",
                ClientId = "aira",
                ClientSecret = "${secret:client_secret}"
            }
        };
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("outside this project's allowed hosts"));
    }

    [Fact]
    public void Accepts_oauth_when_the_token_endpoint_is_allowed_and_the_secret_is_referenced()
    {
        var request = Get() with
        {
            Auth = new ApiAuthDescriptor
            {
                Mode = ApiAuthMode.OAuth2ClientCredentials,
                TokenUrl = "https://api.example.com/oauth/token",
                ClientId = "aira",
                ClientSecret = "${secret:client_secret}",
                Scope = "accounts.read"
            }
        };
        ApiRequestValidator.Validate(request, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void Rejects_an_unknown_authentication_mode()
    {
        var request = Get() with { Auth = new ApiAuthDescriptor { Mode = (ApiAuthMode)99 } };
        var result = ApiRequestValidator.Validate(request, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("Unknown API authentication mode"));
    }

    [Fact]
    public void Rejects_a_timeout_outside_the_permitted_range()
    {
        ApiRequestValidator.Validate(Get() with { TimeoutMs = -1 }, Policy()).IsValid.Should().BeFalse();
        ApiRequestValidator.Validate(Get() with { TimeoutMs = 300_001 }, Policy()).IsValid.Should().BeFalse();
        ApiRequestValidator.Validate(Get() with { TimeoutMs = 5000 }, Policy()).IsValid.Should().BeTrue();
    }

    [Theory]
    [InlineData("accounts[0].id")]
    [InlineData("$.data.accounts[12].balance")]
    [InlineData("a.b.c")]
    [InlineData("$")]
    [InlineData("accounts.0.id")]
    public void Accepts_the_supported_json_path_grammar(string path)
    {
        ApiRequestValidator.IsJsonPath(path).Should().BeTrue();
    }

    [Theory]
    [InlineData("accounts[*].id")]        // wildcards would make behaviour unpredictable
    [InlineData("$..id")]                 // recursive descent, likewise
    [InlineData("accounts[?(@.id)]")]     // filter expressions
    [InlineData("accounts[0")]
    [InlineData("1abc")]
    [InlineData("a b")]
    public void Rejects_path_syntax_it_cannot_evaluate_predictably(string path)
    {
        ApiRequestValidator.IsJsonPath(path).Should().BeFalse();
    }

    [Fact]
    public void Rejects_a_capture_with_an_unusable_name_or_path()
    {
        var badName = Get() with { Capture = new Dictionary<string, string> { ["a name"] = "id" } };
        var badPath = Get() with { Capture = new Dictionary<string, string> { ["accountId"] = "accounts[*].id" } };

        ApiRequestValidator.Validate(badName, Policy()).Errors
            .Should().Contain(e => e.Contains("not a usable test-data name"));
        ApiRequestValidator.Validate(badPath, Policy()).Errors
            .Should().Contain(e => e.Contains("not a supported JSON path"));
    }

    [Fact]
    public void Identifies_mutating_methods()
    {
        ApiRequestValidator.IsMutating(Get() with { Method = "post" }).Should().BeTrue();
        ApiRequestValidator.IsMutating(Get() with { Method = "DELETE" }).Should().BeTrue();
        ApiRequestValidator.IsMutating(Get() with { Method = "GET" }).Should().BeFalse();
        ApiRequestValidator.IsMutating(Get() with { Method = "HEAD" }).Should().BeFalse();
    }

    [Fact]
    public void Round_trips_through_storage_without_losing_a_field()
    {
        var request = new ApiRequestDescriptor
        {
            Method = "POST",
            Path = "/api/payments",
            Query = new Dictionary<string, string> { ["dryRun"] = "true" },
            Headers = new Dictionary<string, string> { ["x-idempotency-key"] = "${data:paymentKey}" },
            Body = "{\"amount\":12.5}",
            ContentType = "application/json",
            Auth = new ApiAuthDescriptor { Mode = ApiAuthMode.Bearer, Token = "${secret:api_token}" },
            TimeoutMs = 9000,
            FailOnErrorStatus = false,
            Capture = new Dictionary<string, string> { ["paymentId"] = "payment.id" }
        };

        var restored = ApiRequestValidator.Deserialize(ApiRequestValidator.Serialize(request));

        restored.Should().NotBeNull();
        restored!.Method.Should().Be("POST");
        restored.Path.Should().Be("/api/payments");
        restored.Query!["dryRun"].Should().Be("true");
        restored.Headers!["x-idempotency-key"].Should().Be("${data:paymentKey}");
        restored.Body.Should().Be("{\"amount\":12.5}");
        restored.Auth!.Mode.Should().Be(ApiAuthMode.Bearer);
        restored.Auth.Token.Should().Be("${secret:api_token}");
        restored.TimeoutMs.Should().Be(9000);
        restored.FailOnErrorStatus.Should().BeFalse();
        restored.Capture!["paymentId"].Should().Be("payment.id");
    }

    [Fact]
    public void Deserialize_returns_null_rather_than_throwing_on_nothing()
    {
        ApiRequestValidator.Deserialize(null).Should().BeNull();
        ApiRequestValidator.Deserialize("  ").Should().BeNull();
    }
}

/// <summary>The API request verb inside the action validator, including the thing that
/// nearly shipped broken: a verb added in the old assertion number range would have been
/// reported as an assertion.</summary>
public class ApiRequestActionTests
{
    private static BrowserActionPolicy Policy()
        => new(AllowScriptExecution: false, AllowXPathLocators: true,
            (string url, out string reason) => { reason = string.Empty; return true; });

    [Fact]
    public void An_api_request_is_not_an_assertion()
    {
        new BrowserAction { Action = BrowserActionType.ApiRequest }.IsAssertion.Should().BeFalse();
        BrowserActionVerbs.IsAssertion(BrowserActionType.ApiRequest).Should().BeFalse();
        BrowserActionVerbs.IsApi(BrowserActionType.ApiRequest).Should().BeTrue();
    }

    [Fact]
    public void Every_assert_verb_is_still_recognised_as_an_assertion()
    {
        var assertVerbs = Enum.GetValues<BrowserActionType>()
            .Where(verb => verb.ToString().StartsWith("Assert", StringComparison.Ordinal));

        assertVerbs.Should().NotBeEmpty();
        foreach (var verb in assertVerbs)
        {
            BrowserActionVerbs.IsAssertion(verb).Should().BeTrue($"{verb} is an assertion verb");
        }
    }

    [Fact]
    public void No_other_verb_is_recognised_as_an_assertion()
    {
        var others = Enum.GetValues<BrowserActionType>()
            .Where(verb => !verb.ToString().StartsWith("Assert", StringComparison.Ordinal));

        foreach (var verb in others)
        {
            BrowserActionVerbs.IsAssertion(verb).Should().BeFalse($"{verb} is not an assertion verb");
        }
    }

    [Fact]
    public void An_api_request_verb_requires_a_request_description()
    {
        var action = new BrowserAction { Action = BrowserActionType.ApiRequest };
        var result = BrowserActionValidator.Validate(action, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("requires a request description"));
    }

    [Fact]
    public void A_request_description_on_any_other_verb_is_rejected_rather_than_ignored()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.Click,
            Target = new LocatorDescriptor { Strategy = LocatorStrategy.TestId, Value = "pay" },
            ApiRequest = new ApiRequestDescriptor { Method = "POST", Path = "/api/payments" }
        };
        var result = BrowserActionValidator.Validate(action, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("cannot carry a request description"));
    }

    [Fact]
    public void A_valid_api_request_verb_is_accepted()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.ApiRequest,
            Description = "List accounts",
            ApiRequest = new ApiRequestDescriptor { Method = "GET", Path = "/api/accounts" }
        };
        BrowserActionValidator.Validate(action, Policy()).IsValid.Should().BeTrue();
    }

    [Fact]
    public void An_invalid_request_inside_the_verb_surfaces_its_own_errors()
    {
        var action = new BrowserAction
        {
            Action = BrowserActionType.ApiRequest,
            ApiRequest = new ApiRequestDescriptor { Method = "TRACE", Path = "nope" }
        };
        var result = BrowserActionValidator.Validate(action, Policy());

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.Contains("not a supported HTTP method"));
        result.Errors.Should().Contain(e => e.Contains("must start with '/'"));
    }
}
