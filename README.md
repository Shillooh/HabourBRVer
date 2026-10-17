# ScreenHarbour (Edição Brasil)

**Uma interface cinematográfica premium para Jellyfin, 100% localizada em português e feita para o público brasileiro.**

[![Versão](https://img.shields.io/badge/vers%C3%A3o-v1.5-E50914?style=for-the-badge)](https://github.com/Shillooh/HabourBRVer)
[![Jellyfin](https://img.shields.io/badge/Jellyfin-10.10.7%20%7C%2010.11.x%20%7C%2012.x-00A4DC?style=for-the-badge&logo=jellyfin&logoColor=white)](https://jellyfin.org)
[![Idioma](https://img.shields.io/badge/Idioma-pt--BR-009c3b?style=for-the-badge)](README.md)
[![Licença](https://img.shields.io/badge/Licen%C3%A7a-MIT-yellow?style=for-the-badge)](LICENSE.md)

![ScreenHarbour Brasil](assets/catalogue/screenharbour.png)

> [!NOTE]
> **Hard Fork Independente:** O **ScreenHarbour Brasil** é um hard fork independente do projeto original *ScreenHarbour* (anteriormente *Jellyfin Cinema* e *TV Item Layout* por *jampez77*), mantido e evoluído por **[Shillooh](https://github.com/Shillooh/HabourBRVer)** com foco total no público brasileiro, streaming nacional e automação sem configurações manuais cansativas.

---

## 🌟 O que há de novo na Edição Brasil?

O ScreenHarbour Brasil transforma o Jellyfin em uma central cinematográfica moderna e intuitiva nos modos **TV** (com controle remoto/D-pad) e **Desktop** (mouse e teclado).

### 🚀 1. Fileiras "Em Alta" 100% Dinâmicas via TMDB (Sem Coleções Manuais!)
No projeto original e em outros temas do Jellyfin, para ter fileiras como "Em Alta na Netflix" ou "Top Filmes de Hoje", o administrador precisava instalar plugins complexos como *SmartLists* ou integrar listas externas do *MDBList* e *Trakt*.
* **Automação Nativa no Servidor:** O ScreenHarbour Brasil consulta diretamente a API oficial do **TMDB** (`language=pt-BR`, `region=BR`) todos os dias para identificar as produções em alta no Brasil.
* **Cruzamento Instantâneo com sua Biblioteca:** O plugin cruza a lista do TMDB com o acervo existente no seu servidor Jellyfin. Se você tem o filme ou série, ele entra instantaneamente na fileira de "Em Alta", com numeração visual de ranking (1 a 10), **sem precisar criar nenhuma coleção manual!**

### 🇧🇷 2. Presets Nacionais de Streaming e Provedores
A lista de serviços de streaming foi totalmente reestruturada para o mercado nacional:
* **Provedores Nacionais e Internacionais:** Telas dedicadas e logotipos em alta resolução para **Globoplay**, **Max**, **Prime Video**, **Netflix**, **Brasil Paralelo**, **Disney+**, **Paramount+**, **Discovery+** e **Rakuten Viki**.
* **Disponibilidade Brasil:** Os filtros automáticos de catálogo verificam ofertas válidas no Brasil (`Region=BR`).
* Suporte completo para adicionar seus próprios serviços personalizados nas configurações.

### 🇧🇷 3. Localização 100% em Português do Brasil (pt-BR)
* Menus, preferências, telas de configuração, filtros, notificações, status de reprodução e botões traduzidos com linguagem natural e adaptada ao Brasil.
* Sem termos em inglês ou resíduos do catálogo britânico do fork original.

### 🖱️ 4. Navegação Aperfeiçoada & Rolagem por Arraste (Drag-Scroll)
* **Botões de Rolagem (Chevrons):** Setas elegantes nas extremidades das fileiras para rolagem rápida no mouse.
* **Arrastar e Soltar:** Suporte total a arrastar com o mouse ou toque para rolar carrosséis de mídia de forma ultra suave.
* **Restauração Perfeita de Posição:** Ao assistir a um trailer ou abrir os detalhes de um filme e voltar, o foco e a posição exata da tela são preservados instantaneamente.

### 👑 5. Painel de Controle Administrativo & Padrão Global (Todos os Usuários)
* **Página de Configuração no Dashboard:** Acesse diretamente pelo menu administrativo em **Painel de Controle** → **Plugins** → **ScreenHarbour Brasil**.
* **Padrão Global do Servidor:** Defina uma única vez as configurações globais de **Serviços de Streaming**, **Fileiras da Página Inicial**, **Tela de Carregamento** e **TV Ao Vivo**. Todos os usuários do servidor herdam automaticamente esse catálogo inicial.
* **Gerenciamento Individual de Perfis:** Pelo seletor **Alvo da Edição**, o administrador pode alternar entre o **Padrão Global** ou qualquer conta de usuário do servidor para inspecionar e personalizar configurações específicas.
* **Ações Administrativas em Lote:**
  * **Copiar da minha conta:** Promova as configurações da sua conta pessoal diretamente para o Padrão Global com um clique.
  * **Forçar em todos os usuários:** Resete personalizações individuais caso queira padronizar o catálogo de toda a família.
  * **Restaurar para o Padrão Global:** Reverte o perfil de um usuário específico para voltar a herdar a configuração do servidor.

### 📺 6. Novo Módulo de TV Ao Vivo (LiveTV Box) Estilo TV Box
Inspirado na agilidade e conveniência dos melhores aplicativos de **TV Box** dedicados, o módulo de TV Ao Vivo foi completamente transformado:
* **Gaveta Lateral Retrátil com Categorias Dinâmicas:** Navegação fluida em duas colunas (Categorias à esquerda e Canais ao centro), exibindo logotipos oficiais, números de canal e barra de pesquisa instantânea. Navegue perfeitamente tanto com controle remoto (D-pad) na TV quanto pelo mouse ou toque no celular e PC.
* **Player Híbrido com Suporte Nativo a MPEG-TS e HLS:** Reprodução contínua e sem travamentos diretamente pelo navegador. Streams `.ts` contam com um proxy interno com buffer circular e decodificação via `mpegts.js`, enquanto transmissões `.m3u8` são processadas via `Hls.js`.
* **Filtro Inteligente de Canais Locais por Estado:** Defina seu estado de preferência no Painel de Controle (Bahia, São Paulo, Goiás, Rio de Janeiro, Minas Gerais, etc.). O sistema agrupa e destaca automaticamente a programação regional em `📍 Canais Locais (Seu Estado)`, com isolamento estrito contra vazamento de canais de outras regiões (ex: Paraíba nunca se mistura com Bahia).
* **Categoria Dedicada "Premiere":** Destaque automático para os canais Premiere nacionais, posicionados com prioridade visual imediatamente acima da seção de Esportes e isolados de canais internacionais de cinema.
* **Canal de Boas-Vindas com Failover Automático:** Canal inicial integrado (com fallback resiliente para TV Senado em múltiplas URLs) com recuperação instantânea caso algum fluxo fique indisponível.

---

## 📸 Galeria de Telas

### 📺 Novo Reprodutor LiveTV Box (Interface Dedicada)
![LiveTV Box](assets/screenshots/livetv-player.png)
*Player de TV Ao Vivo integrado estilo TV Box com gaveta lateral retrátil de categorias, números de canal, logotipos, pesquisa instantânea e isolamento inteligente de canais locais.*

### 🎬 Página Inicial Cinematográfica & Hubs de Streaming
| Página Inicial (Hero Banner & Carrossel de Serviços) | Hub da Plataforma (Filmes em Alta TMDB) |
| :---: | :---: |
| ![Homepage](assets/screenshots/homepage.png) | ![Streaming Hub](assets/screenshots/streaming-hub.png) |

### 🍿 Detalhes de Filmes e Séries
| Página de Filme | Página de Série |
| :---: | :---: |
| ![Página de Filme](assets/screenshots/movie-details.png) | ![Página de Série](assets/screenshots/series-details.png) |

### ⚙️ Painel de Controle Administrativo (Padrão Global & TV Box)
| Painel Central de Configurações | Configuração de Serviços & TMDB |
| :---: | :---: |
| ![Painel Admin](assets/screenshots/admin-panel.png) | ![Configuração de Streaming](assets/screenshots/config-streamings.png) |

---

## 🌟 Recursos em Destaque

| Recurso | Descrição |
| --- | --- |
| **Página Inicial Cinematográfica** | Pôsteres estilizados, banners com gradientes imersivos, fileiras ordenadas e suporte integrado ao plugin Jellyfin Featured. |
| **Hubs de Streaming** | Páginas exclusivas para cada plataforma (Globoplay, Netflix, Prime Video, Max, etc.) destacando o acervo do seu servidor pertencente a cada serviço. |
| **LiveTV Box (TV Ao Vivo)** | Player dedicado estilo TV Box com gaveta lateral retrátil de categorias, suporte a MPEG-TS e HLS, isolamento de canais locais por estado (SP, RJ, BA, GO, MG, etc.), Premiere dedicado e canal padrão com failover automático. |
| **Guia de TV ao Vivo Horizontal** | Grade de programação horizontal moderna para IPTV/TV ao vivo com proporções visuais elegantes e navegação por controle remoto. |
| **Navegação In-Player** | Durante a reprodução de um vídeo, pressione a tecla "Para Baixo" ou clique no ícone de navegação para alternar episódios ou ver títulos recomendados sem parar o vídeo. |
| **Tela de Pausa Personalizada** | Ao pausar, veja logo do título, sinopse, progresso e a estimativa de término (*Termina às hh:mm*). |
| **Telas de Carregamento** | Escolha entre animações clássicas: Projetor de cinema, Claquete, Rolo de filme, Contagem regressiva, Holofotes ou o logo do Jellyfin. |
| **Grupos Sazonais** | Decorações e portas de calendário temáticas para **Halloween** e **Natal** (com desbloqueio diário estilo Calendário do Advento). |

---

## 📦 Como Instalar no Jellyfin

### 1. Adicionar o Repositório do Plugin
1. Abra o painel administrativo do seu Jellyfin: **Painel de Controle** → **Plugins** → aba **Repositórios**.
2. Clique no botão **`+`** (Adicionar) e preencha:
   * **Nome do Repositório:** `ScreenHarbour Brasil`
   * **URL do Repositório:**
     ```text
     https://raw.githubusercontent.com/Shillooh/HabourBRVer/main/manifest.json
     ```
3. *(Obrigatório)* Certifique-se de ter também o repositório do plugin **File Transformation** adicionado:
   * **URL:** `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`

### 2. Instalar os Plugins
1. Vá até a aba **Catálogo** no Jellyfin.
2. Localize e instale o **ScreenHarbour Brasil** (versão `1.5`). O Jellyfin selecionará automaticamente o pacote compilado exato para o seu servidor.
3. Instale também o plugin **File Transformation**.
4. **Reinicie o servidor Jellyfin**.

### 3. Ativar a Interface
1. No seu navegador ou aplicativo web de TV, acesse as **Configurações do Usuário** → **Exibição**.
2. Defina o **Modo de Exibição** para **Área de Trabalho (Desktop)** ou **TV**.
3. Recarregue a página (`F5` ou reabra o app na TV) para desfrutar da nova experiência cinematográfica!

> [!TIP]
> Caso já tivesse instalado o plugin original (*TV Item Layout* ou *Jellyfin Cinema*), basta atualizar o repositório no Painel para o link do ScreenHarbour Brasil e realizar a atualização. Todas as suas configurações e GUIDs serão preservados.

---

## 🛠️ Compatibilidade de Versões

O Jellyfin gerencia a compatibilidade de plugins pelo **Target ABI** e runtime do .NET. O repositório unifica a versão do plugin em **`1.5`** para todos os ambientes e entrega o pacote nativo para o seu servidor:

| Versão do Jellyfin | Versão do Plugin | Target ABI | Target Framework | Pacote Gerado |
| :---: | :---: | :---: | :---: | :---: |
| **12.x / 12.0.0+** | `1.5` | `12.0.0` | .NET 10.0 | `TvItemLayout_1.5_jellyfin-12.0.0.zip` |
| **10.11.x** | `1.5` | `10.11.0` | .NET 9.0 | `TvItemLayout_1.5_jellyfin-10.11.0.zip` |
| **10.10.x / 10.10.7** | `1.5` | `10.10.7` | .NET 8.0 | `TvItemLayout_1.5_jellyfin-10.10.7.zip` |

---

## 💻 Desenvolvimento e Compilação Local

Para desenvolvedores que queiram testar ou criar novas funcionalidades localmente:

### Requisitos
* [Node.js](https://nodejs.org) (v18+)
* [.NET SDK](https://dotnet.microsoft.com/download) (versão correspondente ao seu Jellyfin)

### Passo a Passo

```bash
# 1. Clone o repositório
git clone https://github.com/Shillooh/HabourBRVer.git
cd HabourBRVer

# 2. Instale as dependências
npm ci

# 3. Compile a biblioteca cliente TypeScript/CSS
npm run build

# 4. Inicie o servidor de desenvolvimento / demo interativo
npm run dev

# 5. Execute os testes unitários e validações de tipo
npm run typecheck
npm test

# 6. Empacote as versões do plugin do servidor C# (.NET 8, 9 e 10)
python scripts/build-and-package.py
```

---

## 📂 Estrutura do Código

```
├── assets/                     # Ícones, fontes sazonais e logotipos dos provedores (Globoplay, Max, etc.)
├── demo/                       # Ambiente de demonstração independente e dados fictícios
├── scripts/                    # Scripts de build, empacotamento e geração de manifestos
├── server/                     # Código do Plugin em C# (.NET)
│   ├── Api/                    # Controladores da API REST do plugin
│   └── Providers/              # Integração TMDB Brasil (Region=BR), cache e provedores
├── src/                        # Código-fonte do cliente Web (TypeScript e CSS)
│   ├── home-collections.ts     # Gerenciamento de fileiras na tela inicial
│   ├── home-row-scroll.ts      # Controle de scroll, chevrons e drag scrolling
│   ├── provider-brands.ts      # Metadados e marcas dos serviços de streaming brasileiros
│   ├── provider-data.ts        # Lógica de integração e exibição dos catálogos
│   └── ...                     # Visualizações de TV ao vivo, player, navegação, perfis
└── tests/                      # Suite de testes unitários e de integração
```

---

## ⚖️ Créditos e Agradecimentos

* **Mantenedor & Hard Fork Brasil:** [Shillooh](https://github.com/Shillooh/HabourBRVer).
* **Projeto Original:** Agradecimento especial a [jampez77](https://github.com/jampez77) pela base de código do *ScreenHarbour* / *TV Item Layout* / *Jellyfin Cinema*.
* **In-Player Episode Preview:** Padrões de reprodução inspirados em [jampez77/InPlayerEpisodePreview-TV](https://github.com/jampez77/InPlayerEpisodePreview-TV) e [Namo2/InPlayerEpisodePreview](https://github.com/Namo2/InPlayerEpisodePreview).
* **Metadados e Imagens:** Este produto utiliza a API do [The Movie Database (TMDB)](https://www.themoviedb.org/), mas não é endossado ou certificado pelo TMDB.
* **Marcas Registradas:** Todos os logotipos de serviços de streaming (Globoplay, Netflix, Max, Prime Video, Disney+, etc.) pertencem aos seus respectivos proprietários e são utilizados unicamente para identificação dos catálogos.
* **Licença:** Distribuído sob a licença **MIT**. Consulte o arquivo [LICENSE.md](LICENSE.md) para mais detalhes.
