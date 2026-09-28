using QaNxt.Infrastructure.Persistence;
using FluentAssertions;
using Xunit;

namespace QaNxt.UnitTests.Persistence;

public class SnakeCaseNamingTests
{
    [Theory]
    [InlineData("Id", "id")]
    [InlineData("TestCaseId", "test_case_id")]
    [InlineData("OrganizationId", "organization_id")]
    [InlineData("AiRequestId", "ai_request_id")]
    [InlineData("HttpStatus", "http_status")]
    [InlineData("Sha256", "sha256")]
    [InlineData("URLValue", "url_value")]
    [InlineData("IX_test_cases_ProjectId", "ix_test_cases_project_id")]
    public void Converts_identifiers_the_way_postgres_expects(string input, string expected)
        => SnakeCaseNaming.ToSnakeCase(input).Should().Be(expected);

    [Fact]
    public void Leaves_already_snake_cased_names_alone()
        => SnakeCaseNaming.ToSnakeCase("already_snake_case").Should().Be("already_snake_case");
}
