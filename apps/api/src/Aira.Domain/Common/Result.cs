namespace Aira.Domain.Common;

/// <summary>Error categories that map deterministically onto HTTP status codes and
/// onto CLI exit codes, so that failures stay structured end to end.</summary>
public enum ErrorKind
{
    None = 0,
    Validation,
    NotFound,
    Conflict,
    Forbidden,
    Unauthorized,
    RateLimited,
    Dependency,
    Unexpected
}

public sealed record Error(ErrorKind Kind, string Code, string Message, IReadOnlyDictionary<string, string[]>? Details = null)
{
    public static Error Validation(string message, IReadOnlyDictionary<string, string[]>? details = null)
        => new(ErrorKind.Validation, "validation_failed", message, details);

    public static Error NotFound(string what) => new(ErrorKind.NotFound, "not_found", $"{what} was not found.");
    public static Error Conflict(string code, string message) => new(ErrorKind.Conflict, code, message);
    public static Error Forbidden(string message = "You do not have permission to perform this action.")
        => new(ErrorKind.Forbidden, "forbidden", message);
    public static Error Unauthorized(string message = "Authentication is required.")
        => new(ErrorKind.Unauthorized, "unauthorized", message);
    public static Error Dependency(string code, string message) => new(ErrorKind.Dependency, code, message);
}

/// <summary>A use-case outcome. Use cases return this instead of throwing for expected
/// failures; exceptions remain for genuinely exceptional conditions.</summary>
public readonly record struct Result
{
    private Result(bool isSuccess, Error? error) { IsSuccess = isSuccess; Error = error; }
    public bool IsSuccess { get; }
    public Error? Error { get; }
    public bool IsFailure => !IsSuccess;
    public static Result Success() => new(true, null);
    public static Result Failure(Error error) => new(false, error);
}

public readonly record struct Result<T>
{
    private Result(bool isSuccess, T? value, Error? error) { IsSuccess = isSuccess; Value = value; Error = error; }
    public bool IsSuccess { get; }
    public T? Value { get; }
    public Error? Error { get; }
    public bool IsFailure => !IsSuccess;
    public static Result<T> Success(T value) => new(true, value, null);
    public static Result<T> Failure(Error error) => new(false, default, error);
    public static implicit operator Result<T>(Error error) => Failure(error);
}
