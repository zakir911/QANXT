namespace Aira.Api.Contracts;

/// <summary>Uniform envelope for list endpoints so the console's table components can be
/// generic over resource type.</summary>
public sealed record PagedResponse<T>(IReadOnlyList<T> Items, int Page, int PageSize, long TotalCount)
{
    public int TotalPages => PageSize <= 0 ? 0 : (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasNext => Page * PageSize < TotalCount;
}

public sealed record ApiError(string Code, string Title, int Status, string? CorrelationId = null,
    IReadOnlyDictionary<string, string[]>? Errors = null);

/// <summary>Query parameters shared by every list endpoint.</summary>
public class PageQuery
{
    private int _pageSize = 25;
    public int Page { get; set; } = 1;

    /// <summary>Capped so a caller cannot ask for an unbounded result set.</summary>
    public int PageSize
    {
        get => _pageSize;
        set => _pageSize = value switch { < 1 => 1, > 200 => 200, _ => value };
    }

    public string? Search { get; set; }
    public string? SortBy { get; set; }
    public bool Descending { get; set; } = true;
}
