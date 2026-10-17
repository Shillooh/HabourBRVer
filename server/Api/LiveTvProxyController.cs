using System.Buffers;
using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.TvItemLayout.Api;

internal sealed class LiveTvSession : IAsyncDisposable
{
    private readonly IHttpClientFactory _httpClientFactory;
    public string Id { get; }
    public string TargetUrl { get; }
    public CancellationTokenSource Cts { get; } = new();
    public Channel<byte[]> Channel { get; } = System.Threading.Channels.Channel.CreateBounded<byte[]>(
        new BoundedChannelOptions(260) // ~17 MB de capacidade máxima em RAM
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleWriter = true,
            SingleReader = false
        });
    public TaskCompletionSource<bool> ReadyTcs { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public DateTime LastAccessUtc { get; set; } = DateTime.UtcNow;
    public bool IsClosed { get; private set; }
    public int StatusCode { get; set; } = 200;

    private HttpResponseMessage? _upstreamResponse;
    private Stream? _upstreamStream;

    public LiveTvSession(string id, string targetUrl, IHttpClientFactory httpClientFactory)
    {
        Id = id;
        TargetUrl = targetUrl;
        _httpClientFactory = httpClientFactory;
    }

    public async Task StartAsync()
    {
        try
        {
            _upstreamResponse = await LiveTvProxyController.SendWithManualRedirectsAsync(_httpClientFactory, TargetUrl, Cts.Token).ConfigureAwait(false);
            if (!_upstreamResponse.IsSuccessStatusCode)
            {
                StatusCode = (int)_upstreamResponse.StatusCode;
                ReadyTcs.TrySetResult(false);
                return;
            }

            _upstreamStream = await _upstreamResponse.Content.ReadAsStreamAsync(Cts.Token).ConfigureAwait(false);
            const int BlockSize = 65424; // Múltiplo exato de pacotes MPEG-TS (348 * 188 bytes ≈ 64 KB)
            var accumulator = new byte[BlockSize * 2];
            int accCount = 0;
            var readBuffer = new byte[32768];

            while (!Cts.IsCancellationRequested)
            {
                if ((DateTime.UtcNow - LastAccessUtc).TotalSeconds > 15)
                {
                    break;
                }

                using var readTimeoutCts = CancellationTokenSource.CreateLinkedTokenSource(Cts.Token);
                readTimeoutCts.CancelAfter(TimeSpan.FromSeconds(15));

                int read = await _upstreamStream.ReadAsync(readBuffer.AsMemory(0, readBuffer.Length), readTimeoutCts.Token).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }

                Buffer.BlockCopy(readBuffer, 0, accumulator, accCount, read);
                accCount += read;

                while (accCount >= BlockSize)
                {
                    var chunk = new byte[BlockSize];
                    Buffer.BlockCopy(accumulator, 0, chunk, 0, BlockSize);
                    Channel.Writer.TryWrite(chunk);

                    accCount -= BlockSize;
                    if (accCount > 0)
                    {
                        Buffer.BlockCopy(accumulator, BlockSize, accumulator, 0, accCount);
                    }

                    if (!ReadyTcs.Task.IsCompleted)
                    {
                        ReadyTcs.TrySetResult(true);
                    }
                }
            }

            // Se encerrou a leitura e sobrou algum múltiplo de 188 bytes, enfileira o resto alinhado
            if (accCount >= 188)
            {
                int finalAligned = (accCount / 188) * 188;
                var finalChunk = new byte[finalAligned];
                Buffer.BlockCopy(accumulator, 0, finalChunk, 0, finalAligned);
                Channel.Writer.TryWrite(finalChunk);
            }
        }
        catch (Exception)
        {
            ReadyTcs.TrySetResult(false);
        }
        finally
        {
            IsClosed = true;
            Channel.Writer.TryComplete();
            LiveTvProxyController.Sessions.TryRemove(Id, out _);
            await DisposeAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (IsClosed && _upstreamStream == null && _upstreamResponse == null) return;
        IsClosed = true;
        try { Cts.Cancel(); } catch { }
        if (_upstreamStream != null)
        {
            try { await _upstreamStream.DisposeAsync().ConfigureAwait(false); } catch { }
            _upstreamStream = null;
        }
        if (_upstreamResponse != null)
        {
            try { _upstreamResponse.Dispose(); } catch { }
            _upstreamResponse = null;
        }
        Cts.Dispose();
    }
}

[ApiController]
[Route("TvItemLayout/LiveTv")]
[AllowAnonymous]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class LiveTvProxyController(IHttpClientFactory httpClientFactory) : ControllerBase
{
    internal static readonly ConcurrentDictionary<string, LiveTvSession> Sessions = new();

    private static async Task StopAllSessionsAsync()
    {
        foreach (var kvp in Sessions)
        {
            if (Sessions.TryRemove(kvp.Key, out var session))
            {
                await session.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    private static readonly Regex KeyUriRegex = new(@"(URI=[""'])([^""']+)([""'])", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    internal static readonly string[] FallbackUserAgents =
    [
        "VLC/3.0.20 LibVLC/3.0.20",
        "okhttp/5.0.0-alpha.2",
        "Mozilla/5.0 (Linux; Android 12; Chromecast) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "VLC"
    ];

    private static IHttpResponseBodyFeature GetUnbufferedResponseBodyFeature(HttpContext context)
    {
        var feature = context.Features.Get<IHttpResponseBodyFeature>()
            ?? throw new InvalidOperationException("IHttpResponseBodyFeature not found.");

        // Desencapsula qualquer MemoryStream/Wrapper injetado por middlewares (FileTransformation, Compression, etc.)
        while (feature is StreamResponseBodyFeature { PriorFeature: not null } wrapper)
        {
            feature = wrapper.PriorFeature;
        }

        // Restaura a feature raiz do Kestrel no HttpContext para que o pipeline escreva direto no socket TCP
        context.Features.Set<IHttpResponseBodyFeature>(feature);
        feature.DisableBuffering();
        return feature;
    }

    public static async Task<HttpResponseMessage> SendWithManualRedirectsAsync(
        IHttpClientFactory httpClientFactory,
        string rawUrl,
        CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var targetUri))
        {
            throw new ArgumentException("Invalid URL.", nameof(rawUrl));
        }

        var client = httpClientFactory.CreateClient("LiveTvProxy");
        var currentUri = targetUri;

        for (int hop = 0; hop < 6; hop++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, currentUri);
            req.Headers.TryAddWithoutValidation("User-Agent", FallbackUserAgents[0]);
            req.Headers.TryAddWithoutValidation("Accept", "*/*");

            var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);

            if ((int)resp.StatusCode is 301 or 302 or 303 or 307 or 308 && resp.Headers.Location != null)
            {
                var loc = resp.Headers.Location;
                currentUri = loc.IsAbsoluteUri ? loc : new Uri(currentUri, loc);
                resp.Dispose(); // CRÍTICO: Fecha imediatamente o hop intermediário para liberar a conexão no provedor!
                continue;
            }

            if (resp.IsSuccessStatusCode)
            {
                return resp;
            }

            if (resp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized or HttpStatusCode.BadRequest)
            {
                var lastResp = resp;
                foreach (var ua in FallbackUserAgents.Skip(1))
                {
                    if (cancellationToken.IsCancellationRequested) break;
                    using var altReq = new HttpRequestMessage(HttpMethod.Get, currentUri);
                    altReq.Headers.TryAddWithoutValidation("User-Agent", ua);
                    altReq.Headers.TryAddWithoutValidation("Accept", "*/*");

                    try
                    {
                        var altResp = await client.SendAsync(altReq, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
                        if (altResp.IsSuccessStatusCode)
                        {
                            lastResp.Dispose();
                            return altResp;
                        }
                        altResp.Dispose();
                    }
                    catch { }
                }
                return lastResp;
            }

            return resp;
        }

        throw new HttpRequestException("Too many redirects.");
    }

    private async Task<HttpResponseMessage> SendWithAgentRotationAsync(
        HttpClient client,
        Uri uri,
        HttpCompletionOption completionOption,
        CancellationToken cancellationToken)
    {
        var currentUri = uri;
        for (int hop = 0; hop < 6; hop++)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            var req = new HttpRequestMessage(HttpMethod.Get, currentUri);
            req.Headers.TryAddWithoutValidation("User-Agent", FallbackUserAgents[0]);
            req.Headers.TryAddWithoutValidation("Accept", "*/*");
            req.Headers.TryAddWithoutValidation("Range", "bytes=0-");
            req.Headers.TryAddWithoutValidation("Connection", "keep-alive");

            HttpResponseMessage resp;
            try
            {
                resp = await client.SendAsync(req, completionOption, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                break;
            }

            // Segue redirecionamentos (301, 302, 307, 308) manualmente preservando os headers exatos!
            if ((int)resp.StatusCode is 301 or 302 or 307 or 308 && resp.Headers.Location != null)
            {
                var loc = resp.Headers.Location;
                currentUri = loc.IsAbsoluteUri ? loc : new Uri(currentUri, loc);
                resp.Dispose();
                continue;
            }

            if (resp.IsSuccessStatusCode)
            {
                return resp;
            }

            // Se o primeiro UA foi rejeitado (ex: 401, 403), tenta UAs alternativos nesta mesma URI
            if (resp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized or HttpStatusCode.BadRequest)
            {
                resp.Dispose();
                foreach (var ua in FallbackUserAgents.Skip(1))
                {
                    if (cancellationToken.IsCancellationRequested) break;
                    var altReq = new HttpRequestMessage(HttpMethod.Get, currentUri);
                    altReq.Headers.TryAddWithoutValidation("User-Agent", ua);
                    altReq.Headers.TryAddWithoutValidation("Accept", "*/*");
                    altReq.Headers.TryAddWithoutValidation("Range", "bytes=0-");

                    try
                    {
                        var altResp = await client.SendAsync(altReq, completionOption, cancellationToken);
                        if (altResp.IsSuccessStatusCode)
                        {
                            return altResp;
                        }
                        altResp.Dispose();
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch { }
                }
            }

            return resp;
        }

        using var finalReq = new HttpRequestMessage(HttpMethod.Get, currentUri);
        finalReq.Headers.TryAddWithoutValidation("User-Agent", FallbackUserAgents[0]);
        return await client.SendAsync(finalReq, completionOption, cancellationToken);
    }

    [HttpOptions("ProxyM3u8")]
    [HttpOptions("ProxySegment")]
    [HttpOptions("ProxyStream")]
    [HttpOptions("DiagnoseStream")]
    [HttpOptions("ProbeVersion")]
    [HttpOptions("ProbeProxy")]
    [HttpOptions("StartSession")]
    [HttpOptions("ReadChunk")]
    [HttpOptions("StopSession")]
    public IActionResult Options()
    {
        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, HEAD, OPTIONS";
        Response.Headers["Access-Control-Allow-Headers"] = "*";
        return Ok();
    }

    [HttpGet("StartSession")]
    public async Task<IActionResult> StartSession([FromQuery] string url, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var targetUri))
        {
            return BadRequest(new { error = "Invalid URL" });
        }

        // 1. Encerra qualquer sessão anterior para proteger o limite de 3 telas
        await StopAllSessionsAsync().ConfigureAwait(false);

        var sessionId = Guid.NewGuid().ToString("N");
        var session = new LiveTvSession(sessionId, url, httpClientFactory);
        Sessions[sessionId] = session;

        // Inicia a leitura em background fora do HttpContext
        _ = Task.Run(() => session.StartAsync());

        // Aguarda a sessão ficar pronta (ler o primeiro bloco) por até 6s
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(6));

        try
        {
            var success = await session.ReadyTcs.Task.WaitAsync(timeoutCts.Token).ConfigureAwait(false);
            if (!success)
            {
                await session.DisposeAsync().ConfigureAwait(false);
                Sessions.TryRemove(sessionId, out _);
                return StatusCode(session.StatusCode, new { error = "Failed to start upstream stream" });
            }

            Response.Headers["Access-Control-Allow-Origin"] = "*";
            Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            Response.Headers["Access-Control-Allow-Headers"] = "*";
            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";

            return Ok(new { sessionId, status = 200 });
        }
        catch (OperationCanceledException)
        {
            await session.DisposeAsync().ConfigureAwait(false);
            Sessions.TryRemove(sessionId, out _);
            return StatusCode(StatusCodes.Status504GatewayTimeout, new { error = "Upstream connect timeout" });
        }
    }

    [HttpGet("ReadChunk")]
    public async Task<IActionResult> ReadChunk([FromQuery] string sessionId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || !Sessions.TryGetValue(sessionId, out var session))
        {
            return StatusCode(StatusCodes.Status410Gone);
        }

        session.LastAccessUtc = DateTime.UtcNow;

        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
        Response.Headers["Access-Control-Allow-Headers"] = "*";
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";

        var reader = session.Channel.Reader;
        var chunks = new List<byte[]>();
        int totalBytes = 0;
        const int minBatchBytes = 196272; // ~192 KB (3 * 65424 bytes)
        const int maxBatchBytes = 785088; // ~768 KB (12 * 65424 bytes)

        // 1. Drena todos os blocos já prontos na fila
        while (totalBytes < maxBatchBytes && reader.TryRead(out var immediateChunk))
        {
            chunks.Add(immediateChunk);
            totalBytes += immediateChunk.Length;
        }

        // 2. Se tiver menos de 192 KB, aguarda novos blocos até completar minBatchBytes ou até estourar 350ms
        if (totalBytes < minBatchBytes && !session.IsClosed)
        {
            using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            waitCts.CancelAfter(TimeSpan.FromMilliseconds(350));
            try
            {
                while (totalBytes < minBatchBytes && await reader.WaitToReadAsync(waitCts.Token).ConfigureAwait(false))
                {
                    while (totalBytes < maxBatchBytes && reader.TryRead(out var nextChunk))
                    {
                        chunks.Add(nextChunk);
                        totalBytes += nextChunk.Length;
                    }

                    if (totalBytes >= minBatchBytes)
                    {
                        break;
                    }
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // Timeout de 350ms atingido. Se já acumulou pelo menos 1 bloco de 64KB, prossegue e entrega!
            }
        }

        if (totalBytes == 0)
        {
            if (session.IsClosed)
            {
                return StatusCode(StatusCodes.Status410Gone);
            }
            return StatusCode(StatusCodes.Status204NoContent);
        }

        byte[] payload;
        if (chunks.Count == 1)
        {
            payload = chunks[0];
        }
        else
        {
            payload = new byte[totalBytes];
            int offset = 0;
            foreach (var c in chunks)
            {
                Buffer.BlockCopy(c, 0, payload, offset, c.Length);
                offset += c.Length;
            }
        }

        return File(payload, "application/octet-stream");
    }

    [HttpGet("StopSession")]
    [HttpPost("StopSession")]
    public async Task<IActionResult> StopSession([FromQuery] string? sessionId)
    {
        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        Response.Headers["Access-Control-Allow-Headers"] = "*";

        if (!string.IsNullOrWhiteSpace(sessionId) && Sessions.TryRemove(sessionId, out var session))
        {
            await session.DisposeAsync().ConfigureAwait(false);
        }
        else
        {
            await StopAllSessionsAsync().ConfigureAwait(false);
        }

        return Ok(new { stopped = true });
    }

    [HttpGet("ProbeVersion")]
    public IActionResult ProbeVersion()
    {
        Response.Headers["Access-Control-Allow-Origin"] = "*";
        return Ok(new
        {
            version = "2026.10.16.2255",
            framework = Environment.Version.ToString(),
            os = Environment.OSVersion.ToString(),
            assemblyPath = typeof(LiveTvProxyController).Assembly.Location
        });
    }

    [HttpGet("ProbeProxy")]
    public async Task<IActionResult> ProbeProxy([FromQuery] string url, CancellationToken cancellationToken = default)
    {
        var logs = new List<string>();
        var sw = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            var initialBodyType = Response.Body.GetType().FullName;
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Initial Response.Body type: {initialBodyType}");

            var feature = HttpContext.Features.Get<IHttpResponseBodyFeature>();
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Initial IHttpResponseBodyFeature: {feature?.GetType().FullName}");

            var unbuffered = GetUnbufferedResponseBodyFeature(HttpContext);
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Unbuffered IHttpResponseBodyFeature: {unbuffered.GetType().FullName}");
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Unbuffered Stream type: {unbuffered.Stream.GetType().FullName}");

            logs.Add($"[{sw.ElapsedMilliseconds}ms] Target: {url}");
            using var resp = await SendWithManualRedirectsAsync(httpClientFactory, url, cancellationToken);
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Upstream Status: {(int)resp.StatusCode} {resp.StatusCode}");

            if (resp.IsSuccessStatusCode)
            {
                await using var stream = await resp.Content.ReadAsStreamAsync(cancellationToken);
                var buffer = new byte[4096];
                var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken);
                logs.Add($"[{sw.ElapsedMilliseconds}ms] Success! Read {bytesRead} bytes from upstream stream.");
                return Ok(new { success = true, logs });
            }

            return Ok(new { success = false, logs });
        }
        catch (Exception ex)
        {
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Exception: {ex.Message}");
            return Ok(new { success = false, logs, error = ex.ToString() });
        }
    }

    [HttpGet("DiagnoseStream")]
    public async Task<IActionResult> DiagnoseStream([FromQuery] string url)
    {
        var logs = new List<string>();
        var sw = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Target URL: {url}");
            if (!Uri.TryCreate(url, UriKind.Absolute, out var targetUri))
            {
                return BadRequest(new { logs, error = "Invalid URL" });
            }

            var handler = new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                ConnectTimeout = TimeSpan.FromSeconds(5)
            };
            using var client = new HttpClient(handler);
            client.Timeout = TimeSpan.FromSeconds(8);

            var currentUri = targetUri;
            for (int hop = 0; hop < 5; hop++)
            {
                logs.Add($"[{sw.ElapsedMilliseconds}ms] Hop {hop}: Requesting {currentUri}");
                using var req = new HttpRequestMessage(HttpMethod.Get, currentUri);
                req.Headers.TryAddWithoutValidation("User-Agent", FallbackUserAgents[0]);
                req.Headers.TryAddWithoutValidation("Accept", "*/*");

                using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                logs.Add($"[{sw.ElapsedMilliseconds}ms] Hop {hop}: Status = {(int)resp.StatusCode} {resp.StatusCode}");

                foreach (var h in resp.Headers)
                {
                    logs.Add($"Hop {hop} header: {h.Key} = {string.Join(", ", h.Value)}");
                }

                if ((int)resp.StatusCode is 301 or 302 or 307 or 308)
                {
                    var loc = resp.Headers.Location;
                    if (loc == null)
                    {
                        logs.Add($"Hop {hop}: Redirect without Location header!");
                        break;
                    }
                    var nextUri = loc.IsAbsoluteUri ? loc : new Uri(currentUri, loc);
                    logs.Add($"Hop {hop}: Redirected to -> {nextUri}");
                    currentUri = nextUri;
                    continue;
                }

                if (resp.IsSuccessStatusCode)
                {
                    using var s = await resp.Content.ReadAsStreamAsync();
                    var buf = new byte[1024];
                    var r = await s.ReadAsync(buf, 0, buf.Length);
                    logs.Add($"[{sw.ElapsedMilliseconds}ms] Success! Read {r} bytes from body.");
                    return Ok(new { success = true, logs });
                }

                logs.Add($"[{sw.ElapsedMilliseconds}ms] Stopped at status {(int)resp.StatusCode}");
                return Ok(new { success = false, logs });
            }

            return Ok(new { success = false, logs, message = "Too many redirects" });
        }
        catch (Exception ex)
        {
            logs.Add($"[{sw.ElapsedMilliseconds}ms] Exception: {ex.GetType().FullName}: {ex.Message}");
            if (ex.InnerException != null)
            {
                logs.Add($"Inner: {ex.InnerException.GetType().FullName}: {ex.InnerException.Message}");
            }
            return Ok(new { success = false, logs, exception = ex.ToString() });
        }
    }

    [HttpGet("ProxyM3u8")]
    public async Task<IActionResult> ProxyM3u8([FromQuery] string url, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var targetUri)
            || (targetUri.Scheme != Uri.UriSchemeHttp && targetUri.Scheme != Uri.UriSchemeHttps))
        {
            return BadRequest("Invalid target URL.");
        }

        try
        {
            var client = httpClientFactory.CreateClient("LiveTvProxy");

            // Monta lista ordenada de URIs candidatas a playlist HLS (.m3u8)
            var candidates = new List<Uri>();

            if (targetUri.AbsolutePath.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase))
            {
                candidates.Add(targetUri);
            }
            else
            {
                // Se o link termina em .ts (muito comum em listas IPTV/Xtream Codes), testa substituindo por .m3u8
                if (targetUri.AbsolutePath.EndsWith(".ts", StringComparison.OrdinalIgnoreCase))
                {
                    var builder = new UriBuilder(targetUri)
                    {
                        Path = targetUri.AbsolutePath[..^3] + ".m3u8"
                    };
                    candidates.Add(builder.Uri);
                }
                else
                {
                    // Link sem extensão ou numérico (ex: /live/user/pass/12345 ou /user/pass/12345)
                    var builder = new UriBuilder(targetUri)
                    {
                        Path = targetUri.AbsolutePath + ".m3u8"
                    };
                    candidates.Add(builder.Uri);

                    if (targetUri.AbsolutePath.Contains("/live/", StringComparison.OrdinalIgnoreCase))
                    {
                        var hlsBuilder = new UriBuilder(targetUri)
                        {
                            Path = Regex.Replace(targetUri.AbsolutePath, "/live/", "/hls/", RegexOptions.IgnoreCase) + ".m3u8"
                        };
                        candidates.Add(hlsBuilder.Uri);
                    }
                    else
                    {
                        var segments = targetUri.AbsolutePath.Trim('/').Split('/');
                        if (segments.Length >= 2)
                        {
                            var liveBuilder = new UriBuilder(targetUri)
                            {
                                Path = "/live/" + string.Join('/', segments) + ".m3u8"
                            };
                            candidates.Add(liveBuilder.Uri);
                        }
                    }
                }

                // Testa também a URI original diretamente
                candidates.Add(targetUri);
            }

            foreach (var candidate in candidates)
            {
                if (cancellationToken.IsCancellationRequested) break;

                try
                {
                    using var resp = await SendWithAgentRotationAsync(client, candidate, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                    if (!resp.IsSuccessStatusCode) continue;

                    // Amostra segura dos primeiros 2048 bytes para verificar se é #EXTM3U
                    // Isso evita travar em streams contínuas MPEG-TS que nunca fecham a conexão
                    using var bodyStream = await resp.Content.ReadAsStreamAsync(cancellationToken);
                    var sampleBuffer = new byte[2048];
                    var bytesRead = await bodyStream.ReadAsync(sampleBuffer.AsMemory(0, sampleBuffer.Length), cancellationToken);
                    if (bytesRead <= 0) continue;

                    var sampleText = Encoding.UTF8.GetString(sampleBuffer, 0, bytesRead);
                    if (sampleText.TrimStart().StartsWith("#EXTM3U", StringComparison.OrdinalIgnoreCase))
                    {
                        // É uma playlist HLS real! Lê o restante do arquivo (limite de 2MB)
                        using var ms = new MemoryStream();
                        ms.Write(sampleBuffer, 0, bytesRead);
                        var chunk = new byte[8192];
                        int r;
                        while (ms.Length < 2 * 1024 * 1024 && (r = await bodyStream.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken)) > 0)
                        {
                            ms.Write(chunk, 0, r);
                        }

                        var playlistContent = Encoding.UTF8.GetString(ms.ToArray());
                        return ProcessAndReturnPlaylist(playlistContent, candidate);
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch
                {
                    // Erro nessa candidata, tenta a próxima
                }
            }

            // Nenhuma variante produziu #EXTM3U. O sinal é MPEG-TS bruto (não-HLS).
            Response.Headers["Access-Control-Allow-Origin"] = "*";
            Response.Headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
            Response.Headers["Access-Control-Allow-Headers"] = "*";
            Response.Headers["X-Stream-Type"] = "mpegts";
            return StatusCode(422, "Stream is raw MPEG-TS. Use ProxyStream instead.");
        }
        catch (OperationCanceledException)
        {
            return StatusCode(499);
        }
    }

    private IActionResult ProcessAndReturnPlaylist(string content, Uri baseUri)
    {
        var scheme = Request.Scheme;
        var host = Request.Host.Value;
        var pathBase = Request.PathBase.Value;
        var proxyBase = $"{scheme}://{host}{pathBase}/TvItemLayout/LiveTv";

        var lines = content.Split(["\r\n", "\n"], StringSplitOptions.None);
        var sb = new StringBuilder(content.Length + 1024);

        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (string.IsNullOrEmpty(trimmed))
            {
                sb.AppendLine();
                continue;
            }

            if (trimmed.StartsWith('#'))
            {
                if (trimmed.Contains("URI=", StringComparison.OrdinalIgnoreCase))
                {
                    var rewrittenTag = KeyUriRegex.Replace(trimmed, match =>
                    {
                        var keyUrl = match.Groups[2].Value;
                        if (Uri.TryCreate(baseUri, keyUrl, out var resolvedKeyUri))
                        {
                            var proxiedKey = $"{proxyBase}/ProxySegment?url={Uri.EscapeDataString(resolvedKeyUri.ToString())}";
                            return $"{match.Groups[1].Value}{proxiedKey}{match.Groups[3].Value}";
                        }
                        return match.Value;
                    });
                    sb.AppendLine(rewrittenTag);
                }
                else
                {
                    sb.AppendLine(line);
                }
                continue;
            }

            if (Uri.TryCreate(baseUri, trimmed, out var resolvedUri))
            {
                var uriString = resolvedUri.ToString();
                var isPlaylist = uriString.Contains(".m3u8", StringComparison.OrdinalIgnoreCase);
                var endpoint = isPlaylist ? "ProxyM3u8" : "ProxySegment";
                var proxiedUrl = $"{proxyBase}/{endpoint}?url={Uri.EscapeDataString(uriString)}";
                sb.AppendLine(proxiedUrl);
            }
            else
            {
                sb.AppendLine(line);
            }
        }

        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
        Response.Headers["Access-Control-Allow-Headers"] = "*";
        Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";

        return Content(sb.ToString(), "application/vnd.apple.mpegurl", Encoding.UTF8);
    }

    [HttpGet("ProxyStream")]
    public async Task<IActionResult> ProxyStream([FromQuery] string url, CancellationToken cancellationToken)
    {
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, HttpContext.RequestAborted);
        var ct = linkedCts.Token;

        HttpResponseMessage? upstreamResponse = null;
        try
        {
            upstreamResponse = await SendWithManualRedirectsAsync(httpClientFactory, url, ct).ConfigureAwait(false);
            if (!upstreamResponse.IsSuccessStatusCode)
            {
                Response.StatusCode = (int)upstreamResponse.StatusCode;
                return new EmptyResult();
            }

            // 1. Obtém a feature raiz do Kestrel (ignorando middlewares de buffer) e desabilita buffering
            var bodyFeature = GetUnbufferedResponseBodyFeature(HttpContext);

            // 2. Define cabeçalhos de streaming ao vivo e anti-buffering
            Response.StatusCode = StatusCodes.Status200OK;
            Response.ContentType = "video/mp2t";
            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["X-Accel-Buffering"] = "no";
            Response.Headers["Access-Control-Allow-Origin"] = "*";
            Response.Headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
            Response.Headers["Access-Control-Allow-Headers"] = "*";

            // 3. CRÍTICO: Envia os cabeçalhos HTTP 200 OK IMEDIATAMENTE para o cliente (<200ms)
            await bodyFeature.StartAsync(ct).ConfigureAwait(false);
            await bodyFeature.Stream.FlushAsync(ct).ConfigureAwait(false);

            // 4. Loop de streaming direto do upstream para o socket do Kestrel com timeout por leitura
            await using var upstreamStream = await upstreamResponse.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var buffer = ArrayPool<byte>.Shared.Rent(16384);
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    using var readTimeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    readTimeoutCts.CancelAfter(TimeSpan.FromSeconds(15));

                    int bytesRead = await upstreamStream.ReadAsync(buffer.AsMemory(0, 16384), readTimeoutCts.Token).ConfigureAwait(false);
                    if (bytesRead <= 0)
                    {
                        break;
                    }

                    await bodyFeature.Stream.WriteAsync(buffer.AsMemory(0, bytesRead), ct).ConfigureAwait(false);
                    await bodyFeature.Stream.FlushAsync(ct).ConfigureAwait(false);
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }
        catch (OperationCanceledException)
        {
            // Cliente desconectou / trocou de canal normalmente — encerra silenciosamente
        }
        finally
        {
            // CRÍTICO: Fecha imediatamente a conexão TCP com o provedor IPTV para liberar o limite de 3 telas!
            upstreamResponse?.Dispose();
        }

        return new EmptyResult();
    }

    [HttpGet("ProxySegment")]
    public async Task<IActionResult> ProxySegment([FromQuery] string url, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var targetUri)
            || (targetUri.Scheme != Uri.UriSchemeHttp && targetUri.Scheme != Uri.UriSchemeHttps))
        {
            return BadRequest("Invalid segment URL.");
        }

        try
        {
            var client = httpClientFactory.CreateClient("LiveTvProxy");
            var response = await SendWithAgentRotationAsync(client, targetUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                return StatusCode((int)response.StatusCode, "Upstream segment returned an error.");
            }

            Response.Headers["Access-Control-Allow-Origin"] = "*";
            Response.Headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
            Response.Headers["Access-Control-Allow-Headers"] = "*";
            Response.Headers["Cache-Control"] = "public, max-age=3600";

            var contentType = response.Content.Headers.ContentType?.ToString() ?? "video/mp2t";
            var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            return File(stream, contentType);
        }
        catch (OperationCanceledException)
        {
            return StatusCode(499);
        }
        catch (Exception ex)
        {
            return StatusCode((int)HttpStatusCode.BadGateway, $"Failed to fetch segment: {ex.Message}");
        }
    }
}
