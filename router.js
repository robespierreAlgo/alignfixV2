/**
 * Copyright 2025 Samuel Frontull, Simon Haller-Seeber, and Robert Sama, University of Innsbruck
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
import { renderReview } from "./ui/review.js";

const projectPages = ["project", "stats", "history", "scores", "review"];

function resetContent() {
  const app = document.getElementById("app");
  const sidebar = document.getElementById("sidebar-content");
  if (app) app.innerHTML = "";
  if (sidebar) sidebar.innerHTML = "";
}

function setActiveNav(page) {
  for (const p of projectPages.concat(["home", "about"])) {
    const navItem = document.getElementById(p);
    if (!navItem) continue;

    if (p === page) navItem.classList.add("active");
    else navItem.classList.remove("active");

    if (page === "home" && projectPages.includes(p)) {
      navItem.style.display = "none";
    }
  }
}

function updateNav(projectId, activePage = null) {
  setActiveNav(null);

  for (const page of projectPages) {
    const navItem = document.getElementById(page);
    if (!navItem) continue;

    navItem.style.display = "block";
    navItem.classList.toggle("active", activePage === page);

    const pageLink = navItem.querySelector("a");
    if (pageLink) {
      pageLink.href = `#${page}-${projectId}`;
      pageLink.textContent = `${page.charAt(0).toUpperCase()}${page.slice(1)}`;
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
    case "#review":
      updateNav(projectId, "review");
      renderReview(projectId);
      break;
    case "#about":
      setActiveNav("about");
      renderAbout(app, sidebar);
      break;
    default:
      app.innerHTML = `404 Not Found<br>${route}`;
  }
}

window.addEventListener("hashchange", router);
