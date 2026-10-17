using System.Net;
using Jellyfin.Plugin.TvItemLayout.Integration;
using Jellyfin.Plugin.TvItemLayout.Providers;
using Jellyfin.Plugin.TvItemLayout.Watchlists;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.TvItemLayout;

public sealed class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<StartupService>();
        serviceCollection.AddSingleton<PlaybackQueueStore>();
        serviceCollection.AddSingleton<WatchlistService>();
        serviceCollection.AddScoped<PlaybackQueueCaptureFilter>();
        serviceCollection.Configure<MvcOptions>(options => options.Filters.AddService<PlaybackQueueCaptureFilter>());
        serviceCollection.AddHttpClient("JellyfinCinemaProviders", client =>
        {
            client.Timeout = TimeSpan.FromSeconds(15);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("ScreenHarbour/1.0");
        }).RemoveAllLoggers(); // The TMDB query string contains its configured API key.
        serviceCollection.AddHttpClient("LiveTvProxy", client =>
        {
            client.Timeout = Timeout.InfiniteTimeSpan;
        }).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            MaxConnectionsPerServer = 32,
            ConnectTimeout = TimeSpan.FromSeconds(10)
        });
        serviceCollection.AddSingleton<TmdbProviderSource>();
        serviceCollection.AddSingleton<ProviderAvailabilityService>();
        serviceCollection.AddSingleton<IProviderAvailability>(services => services.GetRequiredService<ProviderAvailabilityService>());
        serviceCollection.AddHostedService(services => services.GetRequiredService<ProviderAvailabilityService>());
    }
}
