using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.TvItemLayout;

public sealed class Plugin : BasePlugin<BasePluginConfiguration>, IHasWebPages
{
    public const string PluginId = "c985bcfd-992f-4a16-a583-258014d98d75";

    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        IServerConfigurationManager configurationManager)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        ConfigurationManager = configurationManager;
    }

    public static Plugin Instance { get; private set; } = null!;

    internal IServerConfigurationManager ConfigurationManager { get; }

    public override string Name => "HabourBR";

    public override Guid Id => Guid.Parse(PluginId);

    public override string Description => "Interface cinematográfica para Jellyfin com HabourBR, incluindo fileiras personalizadas de coleções e serviços de streaming, guia de TV ao vivo e navegação in-player.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "habourbr",
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
                EnableInMainMenu = true
            },
            new PluginPageInfo
            {
                Name = "kikotv",
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
                EnableInMainMenu = false
            },
            new PluginPageInfo
            {
                Name = "ScreenHarbour Brasil",
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
                EnableInMainMenu = false
            }
        };
    }
}

