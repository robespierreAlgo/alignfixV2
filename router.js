/**
 * Copyright 2025 Samuel Frontull and Simon Haller-Seeber, University of Innsbruck
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { renderHome } from "./ui/home.js";
import { renderProject } from "./ui/project.js";
import { renderStats } from "./ui/stats.js";
import { renderAbout } from "./ui/about.js";
import { renderHistory } from "./ui/history.js";
import { renderScores } from "./ui/scores.js";

const projectPages = ["project", "stats", "history", "scores"];

function resetContent() {
  const app = document.getElementById("app");
  app.innerHTML = ""; // clear content

  const sidebar = document.getElementById("sidebar-content");
  sidebar.innerHTML = "";
}

function setActiveNav(page) {

  for (const p of projectPages.concat(["home", "about"])) {
    const pageNavItem = document.getElementById(p);
    if (p == page) {
      pageNavItem.classList.add("active");
    } else {
      pageNavItem.classList.remove("active");
    }

    if (page == "home" && p in projectPages) {
      pageNavItem.style.display = "none";
    }
  }

}

function updateNav(projectId, activePage=null) {

  setActiveNav(null);
  
  for (const page of projectPages) {
    const pageNavItem = document.getElementById(page);
      if (pageNavItem) {
        
        if (activePage === page) {
          pageNavItem.classList.add("active");
        } else {
          pageNavItem.classList.remove("active");
        }

        pageNavItem.style.display = "block";
        const pageLink = pageNavItem.querySelector("a");
        if (pageLink) {
          pageLink.href = `#${page}-${projectId}`;
          pageLink.textContent = `${page.charAt(0).toUpperCase() + page.slice(1)}`;
        }
      }
  }
}

export function router() {
  
  resetContent();

  const route = window.location.hash || "#home";
  const app = document.getElementById("app") || document.body;
  const sidebar = document.getElementById("sidebar-content") || null;

  const page = route.split("-")[0];
  const projectId = route.split("-")[1];

  switch (page) {
    case "#home":
      setActiveNav("home");
      renderHome(app);
      break;
    case "#project":
      updateNav(projectId, "project");
      renderProject(projectId);
      break;
    case "#stats":
      updateNav(projectId, "stats");
      renderStats(projectId, true);
      break;
    case "#history":
      updateNav(projectId, "history");
      renderHistory(projectId);
      break;
    case "#scores":
      updateNav(projectId, "scores");
      renderScores(projectId);
      break;
    case "#about":
      setActiveNav("about");
      renderAbout(app, sidebar);
      break;
    default:
      app.innerHTML = "<p>404 Not Found</p>" + route;
  }
}

// Listen to navigation changes
window.addEventListener("hashchange", router);
