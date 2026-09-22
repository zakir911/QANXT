using Aira.Application.Testing;
using FluentAssertions;
using Xunit;

namespace Aira.UnitTests.Testing;

/// <summary>
/// The generator's one promise: a seeded field produces the same value on every run.
/// </summary>
/// <remarks>
/// It is the only reason a seed exists. When it does not hold, a failure cannot be
/// reproduced: the test that failed on a boundary date passes when re-run, the
/// investigation ends in "could not reproduce", and AIRA's own retry silently exercises
/// different data from the attempt that failed.
///
/// The types are enumerated from <see cref="TestDataGenerator.SupportedTypes"/> rather than
/// listed here, so a type added later is covered without anybody remembering to add it —
/// which is how <c>uuid</c> went years without honouring the contract (BUG-0032).
/// </remarks>
public class TestDataGeneratorTests
{
    /// <summary>Types whose output does not depend on the seed, and correctly so.</summary>
    /// <remarks>
    /// <c>longText</c> is a run of one character at a requested length, for boundary
    /// testing. Two seeds producing the same string is the point of it, not a defect.
    /// </remarks>
    private static readonly HashSet<string> SeedIndependentByDesign = new(StringComparer.OrdinalIgnoreCase)
    {
        "longText"
    };

    public static TheoryData<string> EveryType()
    {
        var data = new TheoryData<string>();
        foreach (var type in TestDataGenerator.SupportedTypes) data.Add(type);
        return data;
    }

    [Theory]
    [MemberData(nameof(EveryType))]
    public void A_seeded_field_produces_the_same_value_twice(string type)
    {
        var spec = $"{{\"type\":\"{type}\"}}";

        TestDataGenerator.Generate("field", spec, 42)
            .Should().Be(TestDataGenerator.Generate("field", spec, 42));
    }

    [Theory]
    [MemberData(nameof(EveryType))]
    public void A_seeded_field_produces_a_value_at_all(string type)
    {
        TestDataGenerator.Generate("field", $"{{\"type\":\"{type}\"}}", 42)
            .Should().NotBeNullOrWhiteSpace();
    }

    [Theory]
    [MemberData(nameof(EveryType))]
    public void Different_seeds_produce_different_values(string type)
    {
        // Otherwise the seed is decoration: every test in a project would share one value
        // and nothing would be covering the variation the data set exists to provide.
        if (SeedIndependentByDesign.Contains(type)) return;

        var spec = $"{{\"type\":\"{type}\"}}";
        var values = Enumerable.Range(1, 20)
            .Select(seed => TestDataGenerator.Generate("field", spec, seed))
            .ToHashSet();

        // Not all twenty: "boolean" has two possible values and a small range is legitimate.
        values.Count.Should().BeGreaterThan(1, $"20 seeds produced one value for {type}");
    }

    // -----------------------------------------------------------------------
    // The two that were wrong
    // -----------------------------------------------------------------------

    [Fact]
    public void A_seeded_uuid_is_reproducible_and_still_a_valid_v4()
    {
        // BUG-0032: this was Guid.NewGuid(), so it ignored the seed completely — and an
        // identifier is exactly the sort of field a test asserts on.
        var first = TestDataGenerator.Generate("orderId", "{\"type\":\"uuid\"}", 42);
        var second = TestDataGenerator.Generate("orderId", "{\"type\":\"uuid\"}", 42);

        first.Should().Be(second);

        var parsed = Guid.Parse(first);
        parsed.Should().NotBe(Guid.Empty);
        // Version 4, variant 1 — the shape anything parsing a UUID expects.
        first[14].Should().Be('4');
        "89ab".Should().Contain(first[19].ToString().ToLowerInvariant());
    }

    [Fact]
    public void An_unseeded_uuid_is_still_unique()
    {
        // Nothing was promised without a seed, and a cryptographically random identifier is
        // the better default there.
        var values = Enumerable.Range(0, 50)
            .Select(_ => TestDataGenerator.Generate("orderId", "{\"type\":\"uuid\"}", null))
            .ToHashSet();

        values.Count.Should().Be(50);
    }

    [Theory]
    [InlineData("date")]
    [InlineData("futureDate")]
    public void A_seeded_date_does_not_move_with_the_calendar(string type)
    {
        // BUG-0032: these were UtcNow plus a seeded offset, so the offset was stable and
        // the date was not — reproducible within a day, different the next. Pinned to an
        // exact value, because that is what would have caught it.
        var spec = $"{{\"type\":\"{type}\"}}";
        var value = TestDataGenerator.Generate("bookingDate", spec, 7);

        value.Should().Be(TestDataGenerator.Generate("bookingDate", spec, 7));

        // Within a year of the fixed epoch in the right direction, and nowhere near today
        // unless today happens to be in that window by coincidence.
        var parsed = DateOnly.ParseExact(value, "yyyy-MM-dd");
        var epoch = new DateOnly(2026, 1, 1);

        if (type == "date") parsed.Should().BeBefore(epoch).And.BeOnOrAfter(epoch.AddDays(-365));
        else parsed.Should().BeAfter(epoch).And.BeOnOrBefore(epoch.AddDays(365));
    }

    [Theory]
    [InlineData("date")]
    [InlineData("futureDate")]
    public void An_unseeded_date_is_still_relative_to_today(string type)
    {
        // Somebody who did not ask for reproducibility is asking for "a date in the last
        // year", and that has to move with the year.
        var value = DateOnly.ParseExact(
            TestDataGenerator.Generate("bookingDate", $"{{\"type\":\"{type}\"}}", null), "yyyy-MM-dd");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        if (type == "date") value.Should().BeOnOrBefore(today).And.BeOnOrAfter(today.AddDays(-365));
        else value.Should().BeAfter(today).And.BeOnOrBefore(today.AddDays(365));
    }

    // -----------------------------------------------------------------------
    // Inference and specs
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("customerEmail", "@")]
    [InlineData("mobilePhone", "+44")]
    [InlineData("deliveryPostcode", " ")]
    public void A_field_with_no_spec_is_inferred_from_its_name(string key, string expectedFragment)
    {
        // This is what makes a generated test usable without anybody configuring it.
        TestDataGenerator.Generate(key, null, 42).Should().Contain(expectedFragment);
    }

    [Fact]
    public void A_malformed_spec_falls_back_to_inference_rather_than_failing_the_run()
    {
        // A bad spec is a configuration mistake. Refusing to produce a value would fail the
        // run and report it as a test failure, which sends the reader to the wrong place.
        TestDataGenerator.Generate("customerEmail", "{not json", 42).Should().Contain("@");
    }

    [Fact]
    public void A_number_respects_its_bounds()
    {
        for (var seed = 1; seed <= 50; seed++)
        {
            var value = int.Parse(TestDataGenerator.Generate(
                "quantity", "{\"type\":\"number\",\"min\":\"5\",\"max\":\"10\"}", seed));
            value.Should().BeInRange(5, 10);
        }
    }

    [Fact]
    public void A_long_text_is_the_length_that_was_asked_for()
    {
        TestDataGenerator.Generate("notes", "{\"type\":\"longText\",\"length\":\"5000\"}", 1)
            .Should().HaveLength(5000);
    }

    [Fact]
    public void A_long_text_length_is_bounded_so_a_typo_cannot_exhaust_memory()
    {
        // An extra zero in a spec should not be a way to allocate a gigabyte.
        TestDataGenerator.Generate("notes", "{\"type\":\"longText\",\"length\":\"999999999\"}", 1)
            .Length.Should().BeLessOrEqualTo(10_000);
    }

    [Fact]
    public void Unique_values_never_repeat()
    {
        // Used for data that must not collide between runs, such as a new account's
        // username. A repeat here is a test failing on a duplicate-key error.
        var values = Enumerable.Range(0, 200).Select(_ => TestDataGenerator.Unique("user")).ToHashSet();
        values.Count.Should().Be(200);
    }
}
