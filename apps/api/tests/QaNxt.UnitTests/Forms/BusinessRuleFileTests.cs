using FluentAssertions;
using QaNxt.Application.Forms;
using Xunit;

namespace QaNxt.UnitTests.Forms;

/// <summary>Reading a business rules file far enough to know which screen each rule is about.
///
/// This reader deliberately does not understand a rule. It splits the file into blocks and
/// reads the `rule`, `on` and `means` lines; the expression is carried through as text and
/// parsed in the worker, where the evaluator lives. Two implementations of one expression
/// grammar would drift, and a rule that means one thing to the designer and another to the
/// runner is the worst defect this product could ship — a wrong answer with arithmetic
/// attached.
///
/// So what is tested here is the splitting and the screen matching, and nothing about
/// arithmetic.</summary>
public class BusinessRuleFileTests
{
    private const string File = """
        # Meridian Freight business rules

        rule SURCHARGE_ON_NET
          on      /billing/invoices/new
          means   The fuel surcharge applies to the net amount, not the gross.
          expect  fuelSurcharge == netAmount * 0.085
          within  0.01

        rule CREDIT_NOTE_CAP
          on: /billing/credit-notes/{id}
          means: A credit note can never exceed the invoice it credits.
          expect: creditAmount <= invoiceTotal
        """;

    [Fact]
    public void Both_rules_are_read_with_their_screen_and_their_owners_words()
    {
        var blocks = BusinessRuleFile.Blocks(File);

        blocks.Select(b => b.Id).Should().Equal("SURCHARGE_ON_NET", "CREDIT_NOTE_CAP");
        blocks[0].Screen.Should().Be("/billing/invoices/new");
        blocks[0].Means.Should().Be("The fuel surcharge applies to the net amount, not the gross.");
    }

    [Fact]
    public void The_whole_block_travels_to_the_worker_unchanged_including_its_tolerance()
    {
        // The worker is what parses it, so everything it needs has to be in the text.
        var text = BusinessRuleFile.Blocks(File)[0].Text;

        text.Should().Contain("rule SURCHARGE_ON_NET");
        text.Should().Contain("expect  fuelSurcharge == netAmount * 0.085");
        text.Should().Contain("within  0.01");
    }

    [Fact]
    public void A_colon_after_the_key_is_optional_because_people_write_both_ways()
    {
        BusinessRuleFile.Blocks(File)[1].Screen.Should().Be("/billing/credit-notes/{id}");
    }

    [Fact]
    public void Comments_and_blank_lines_are_not_part_of_a_rule()
    {
        BusinessRuleFile.Blocks("# just a comment\n\n   \n").Should().BeEmpty();
        BusinessRuleFile.Blocks("rule X\n on /a   # the new invoice screen\n expect a == b")[0]
            .Screen.Should().Be("/a");
    }

    [Fact]
    public void A_block_naming_no_screen_is_not_designed_into_a_test()
    {
        // The worker reports what is wrong with a rule, because it is the half that parses.
        // Here the block is simply not turned into a test, so nothing runs against no screen.
        BusinessRuleFile.Blocks("rule X\n expect a == b").Should().BeEmpty();
    }

    [Fact]
    public void A_block_stating_no_expectation_is_not_designed_into_a_test()
    {
        BusinessRuleFile.Blocks("rule X\n on /a\n means something true").Should().BeEmpty();
    }

    [Fact]
    public void Two_rules_of_one_name_yield_one_block_so_neither_silently_replaces_the_other()
    {
        // Both would generate the same key, and the second would overwrite the first.
        var blocks = BusinessRuleFile.Blocks("rule X\n on /a\n expect a == b\nrule X\n on /c\n expect c == d");

        blocks.Should().HaveCount(1);
        blocks[0].Screen.Should().Be("/a");
    }

    [Fact]
    public void Empty_and_null_input_are_not_errors()
    {
        BusinessRuleFile.Blocks(null).Should().BeEmpty();
        BusinessRuleFile.Blocks("").Should().BeEmpty();
        BusinessRuleFile.Blocks("   ").Should().BeEmpty();
    }

    [Fact]
    public void Windows_line_endings_are_read_the_same_as_unix_ones()
    {
        BusinessRuleFile.Blocks("rule X\r\n on /a\r\n expect a == b\r\n").Should().HaveCount(1);
    }

    [Fact]
    public void A_line_before_any_rule_is_ignored_rather_than_attached_to_one()
    {
        var blocks = BusinessRuleFile.Blocks("on /somewhere\nrule X\n on /a\n expect a == b");

        blocks.Should().HaveCount(1);
        blocks[0].Screen.Should().Be("/a");
    }

    [Fact]
    public void The_summary_counts_the_usable_rules_and_the_blocks_that_are_not()
    {
        // A rules file whose every block is incomplete is the one state where this capability
        // silently does nothing, so the counts are part of the application's configuration.
        BusinessRuleFile.Summarise(File).Should().Be((2, 0));
        BusinessRuleFile.Summarise("rule GOOD\n on /a\n expect a == b\nrule BAD\n on /c")
            .Should().Be((1, 1));
        BusinessRuleFile.Summarise(null).Should().Be((0, 0));
    }

    // ---- which screen a rule is about -------------------------------------------------

    [Fact]
    public void An_exact_address_matches_and_an_unrelated_one_does_not()
    {
        var blocks = BusinessRuleFile.Blocks(File);

        BusinessRuleFile.For(blocks, "/billing/invoices/new").Select(b => b.Id)
            .Should().Equal("SURCHARGE_ON_NET");
        BusinessRuleFile.For(blocks, "/fleet/drivers").Should().BeEmpty();
    }

    [Fact]
    public void A_trailing_slash_a_query_and_a_different_case_still_match()
    {
        var blocks = BusinessRuleFile.Blocks(File);

        BusinessRuleFile.For(blocks, "/Billing/Invoices/New/").Should().HaveCount(1);
        BusinessRuleFile.For(blocks, "/billing/invoices/new?from=list").Should().HaveCount(1);
        BusinessRuleFile.For(blocks, "http://localhost:4400/billing/invoices/new").Should().HaveCount(1);
    }

    [Fact]
    public void A_template_matches_the_address_a_run_actually_visits()
    {
        BusinessRuleFile.For(BusinessRuleFile.Blocks(File), "/billing/credit-notes/cn-0004")
            .Select(b => b.Id).Should().Equal("CREDIT_NOTE_CAP");
    }

    [Fact]
    public void A_colon_parameter_template_works_too()
    {
        var blocks = BusinessRuleFile.Blocks("rule R\n on /orders/:orderId/lines\n expect a == b");

        BusinessRuleFile.For(blocks, "/orders/ord-99/lines").Should().HaveCount(1);
    }

    [Fact]
    public void A_template_does_not_match_across_a_slash()
    {
        BusinessRuleFile.For(BusinessRuleFile.Blocks(File), "/billing/credit-notes/cn-0004/lines")
            .Should().BeEmpty();
    }

    [Fact]
    public void A_template_stands_aside_where_another_rule_names_the_address_outright()
    {
        // /billing/invoices/{id} is about one invoice. /billing/invoices/new is the blank form,
        // and a rule about the one is not a rule about the other.
        var blocks = BusinessRuleFile.Blocks("""
            rule DETAIL
              on /billing/invoices/{id}
              expect total >= net
            rule BLANK
              on /billing/invoices/new
              expect total == 0
            """);

        BusinessRuleFile.For(blocks, "/billing/invoices/new").Select(b => b.Id).Should().Equal("BLANK");
        BusinessRuleFile.For(blocks, "/billing/invoices/inv-0004").Select(b => b.Id).Should().Equal("DETAIL");
    }

    [Fact]
    public void The_root_is_matched_rather_than_treated_as_empty()
    {
        var blocks = BusinessRuleFile.Blocks("rule H\n on /\n expect a == b");

        BusinessRuleFile.For(blocks, "http://localhost:4400/").Should().HaveCount(1);
    }
}
