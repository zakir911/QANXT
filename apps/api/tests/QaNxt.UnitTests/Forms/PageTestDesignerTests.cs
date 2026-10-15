using FluentAssertions;
using QaNxt.Application.Contracts;
using QaNxt.Application.Forms;
using QaNxt.Domain.Enums;
using Xunit;

namespace QaNxt.UnitTests.Forms;

/// <summary>Page-level tests: every discovered page gets tests, whether or not it has a
/// form, and each one asserts only what discovery saw.</summary>
public class PageTestDesignerTests
{
    private static DesignElement Element(string name, ElementKind kind, bool visible = true)
        => new(Guid.NewGuid(), kind, name, visible, new LocatorDescriptor { Strategy = LocatorStrategy.Role, Value = kind == ElementKind.Heading ? "heading" : "link", Name = name });

    private static DesignPage Page(string route, string title, params DesignElement[] elements)
        => new(Guid.NewGuid(), $"https://bank.test{route}", route, title, PageKind.Unknown, true, 200, elements);

    private static readonly IReadOnlySet<string> NoSignInNames = new HashSet<string>();

    private static PageDesign Design(DesignPage page, IReadOnlyList<NavigationHop>? path = null, TestingProfile? profile = null, bool signIn = true)
        => PageTestDesigner.Design(new PageDesignContext(page, path ?? Array.Empty<NavigationHop>(), signIn, NoSignInNames, profile ?? new TestingProfile()));

    [Fact]
    public void A_page_with_no_form_still_gets_tests_that_open_it_and_check_its_content()
    {
        var page = Page("/Retail/accounts", "Accounts", Element("My accounts", ElementKind.Heading));
        var smoke = Design(page).Tests.Single(t => t.Technique == "page-opens");

        smoke.Steps.Select(s => s.Action).Should().ContainInOrder(
            BrowserActionType.Navigate, BrowserActionType.AssertNoServerError, BrowserActionType.AssertUrl, BrowserActionType.AssertVisible);
        smoke.Steps.Single(s => s.Action == BrowserActionType.AssertUrl).Expected.Should().Be("/Retail/accounts");
        smoke.Steps.Single(s => s.Action == BrowserActionType.AssertVisible).Target!.Name.Should().Be("My accounts");
    }

    [Fact]
    public void Text_that_reads_like_data_or_a_greeting_is_never_asserted()
    {
        var page = Page("/home", "Home", Element("Welcome back, Zakir", ElementKind.Heading),
            Element("Balance 12,400.00", ElementKind.Heading), Element("Recent transactions", ElementKind.Heading));
        var names = Design(page).Tests.Single(t => t.Technique == "page-opens").Steps
            .Where(s => s.Action == BrowserActionType.AssertVisible).Select(s => s.Target!.Name);
        names.Should().Equal("Recent transactions");
    }

    [Fact]
    public void A_page_reached_by_clicking_gets_an_end_to_end_test_that_clicks_the_same_way()
    {
        var dashboard = Page("/dashboard", "Dashboard", Element("Payments", ElementKind.Link));
        var payments = Page("/payments", "Payments", Element("Beneficiaries", ElementKind.Link), Element("Make a payment", ElementKind.Heading));
        var beneficiaries = Page("/payments/beneficiaries", "Beneficiaries", Element("Saved beneficiaries", ElementKind.Heading));
        var path = new[]
        {
            new NavigationHop(dashboard, dashboard.Elements[0], payments),
            new NavigationHop(payments, payments.Elements[0], beneficiaries)
        };

        var e2e = Design(beneficiaries, path).Tests.Single(t => t.Category == TestCategory.Workflow);
        e2e.Steps.Select(s => (s.Action, s.Url ?? s.Target?.Name ?? s.Expected)).Should().Equal(
            (BrowserActionType.Navigate, "https://bank.test/dashboard"),
            (BrowserActionType.Click, "Payments"),
            (BrowserActionType.Click, "Beneficiaries"),
            (BrowserActionType.AssertUrl, "/payments/beneficiaries"),
            (BrowserActionType.AssertVisible, "Saved beneficiaries"));
    }

    [Fact]
    public void A_page_reached_only_by_its_address_says_so_as_a_gap_instead_of_inventing_a_path()
    {
        var design = Design(Page("/reports", "Reports", Element("Reports", ElementKind.Heading)));
        design.Tests.Should().NotContain(t => t.Category == TestCategory.Workflow);
        design.Gaps.Should().ContainSingle(g => g.Category == TestCategory.Workflow);
    }

    [Theory]
    [InlineData("/Retail/contact-us", "Contact us")]
    [InlineData("/locate-us", "Locate us")]
    [InlineData("/privacy", "Privacy & cookies policy")]
    public void A_page_anyone_may_see_gets_no_signed_out_check(string route, string title)
    {
        Design(Page(route, title, Element("Our branches", ElementKind.Heading))).Tests
            .Should().NotContain(t => t.Technique == "access-control");
    }

    [Fact]
    public void A_signed_in_page_is_checked_hidden_from_a_signed_out_visitor()
    {
        var test = Design(Page("/accounts", "Accounts", Element("My accounts", ElementKind.Heading))).Tests.Single(t => t.Technique == "access-control");
        test.Category.Should().Be(TestCategory.Security);
        test.Steps.Select(s => s.Action).Should().Equal(BrowserActionType.Navigate, BrowserActionType.ClearCookies,
            BrowserActionType.Navigate, BrowserActionType.AssertHidden);
    }

    [Fact]
    public void An_application_with_no_sign_in_gets_no_signed_out_check()
        => Design(Page("/accounts", "Accounts", Element("My accounts", ElementKind.Heading)), signIn: false).Tests
            .Should().NotContain(t => t.Technique == "access-control");

    [Fact]
    public void The_testing_types_chosen_decide_which_page_tests_are_made()
    {
        var quick = Design(Page("/accounts", "Accounts", Element("My accounts", ElementKind.Heading)),
            profile: new TestingProfile { Mode = TestingMode.Custom, Categories = new() { TestCategory.Smoke } });
        quick.Tests.Select(t => t.Category).Distinct().Should().Equal(TestCategory.Smoke);

        var full = Design(Page("/accounts", "Accounts", Element("My accounts", ElementKind.Heading)));
        full.Tests.Select(t => t.Category).Should().Contain(new[]
            { TestCategory.Smoke, TestCategory.Security, TestCategory.Accessibility, TestCategory.Performance, TestCategory.Responsive });
    }

    [Fact]
    public void The_same_page_always_gives_the_same_test_keys()
    {
        var page = Page("/accounts", "Accounts", Element("My accounts", ElementKind.Heading));
        Design(page).Tests.Select(t => t.Key).Should().Equal(Design(page).Tests.Select(t => t.Key));
        Design(page).Tests.Select(t => t.Key).Should().OnlyHaveUniqueItems().And.OnlyContain(k => k.StartsWith("page:"));
    }
}
