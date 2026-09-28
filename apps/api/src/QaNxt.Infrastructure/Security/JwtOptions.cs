namespace QaNxt.Infrastructure.Security;

public sealed class JwtOptions
{
    public string Secret { get; set; } = string.Empty;
    public string Issuer { get; set; } = "qanxt";
    public string Audience { get; set; } = "qanxt-console";
    public int AccessTokenMinutes { get; set; } = 60;
    public int RefreshTokenDays { get; set; } = 14;

    /// <summary>Minimum key length accepted. HS256 with a short key is trivially brute-forced,
    /// so the application refuses to start with one.</summary>
    public const int MinimumSecretLength = 32;
}
